/**
 * 定时轮播（自动换壁纸）回归测试。
 *
 * 在线图源已移除，这里只覆盖本地行为：
 *   1. 关闭自动换图时不排定时器；
 *   2. 开启后按间隔触发，且只在本模式候选里换图；
 *   3. 连续两轮换到不同壁纸；
 *   4. 目录里没有文件时不误触发；
 *   5. 轮播使用静默模式，不打断用户。
 *
 * Run after compilation: node scripts/test-auto-refresh.js
 */
'use strict';
require('./test-env');

const assert = require('assert').strict;
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-auto-refresh-'));
const localFolder = path.join(temporaryRoot, 'wallpapers');
fs.mkdirSync(localFolder);
const localImages = ['one.webp', 'two.webp', 'three.webp']
    .map(name => path.join(localFolder, name));
for (const file of localImages) {
    fs.writeFileSync(file, 'local test image');
}

const globalState = new Map();
const scheduledTimers = new Set();
const appliedImages = [];
const mockEnvironment = { sessionId: 'auto-refresh-test', appRoot: temporaryRoot };
let settings;
let failures = 0;

function getConfiguration() {
    return {
        ...settings,
        get: (key, fallback) => settings[key] ?? fallback,
        update: async (key, value) => { settings[key] = value; }
    };
}

class MockEventEmitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
    dispose() {}
}

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === './settingsStore') {
        return {
            getAppConfig: () => ({
                ...settings,
                get: (key, fallback) => settings[key] ?? fallback,
                has: key => settings[key] !== undefined,
                inspect: key => ({ key, globalValue: settings[key] }),
                update: async (key, value) => { settings[key] = value; }
            }),
            onDidChangeSettings: () => ({ dispose() {} }),
            readSettings: () => ({ ...settings }),
            resetSettings: () => {},
            DEFAULT_SETTINGS: {}
        };
    }
    if (request === 'vscode') {
        return {
            EventEmitter: MockEventEmitter,
            env: mockEnvironment,
            workspace: { getConfiguration },
            window: {
                setStatusBarMessage: () => ({ dispose() {} }),
                createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
                showOpenDialog: async () => undefined,
                showInformationMessage: async () => undefined,
                showWarningMessage: () => undefined,
                showErrorMessage: () => undefined
            },
            commands: { executeCommand() {} },
            Uri: { file: value => ({ with: () => ({ toString: () => String(value) }) }) },
            ConfigurationTarget: { Global: 1 },
            UIKind: { Desktop: 1, Web: 2 },
            Disposable: class {}
        };
    }
    return originalLoad.apply(this, arguments);
};

const { setContext } = require('../out/global');
const { setCurrentImagePath, getPinnedImagePath, getPreviousImagePath } = require('../out/windowBackground');
const { PickList } = require('../out/PickList');
Module._load = originalLoad;

// 只记录"要应用哪张图"，不去真的改工作台文件。
const originalUpdateDom = PickList.prototype.updateDom;
PickList.prototype.updateDom = async function () {
    appliedImages.push({ imagePath: this.imgPath, silent: this.silentApply, randUpdate: this.randUpdate });
    return { applied: true, requiresReload: false };
};

const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
const originalDateNow = Date.now;
let logicalNow = originalDateNow();
Date.now = () => logicalNow;
global.setInterval = (callback, intervalMilliseconds) => {
    const timer = { callback, intervalMilliseconds, elapsedMilliseconds: 0 };
    scheduledTimers.add(timer);
    return timer;
};
global.clearInterval = timer => scheduledTimers.delete(timer);

async function advanceTime(milliseconds) {
    const end = logicalNow + milliseconds;
    while (logicalNow < end) {
        const timers = [...scheduledTimers];
        const step = Math.min(end - logicalNow, ...timers.map(timer => timer.intervalMilliseconds - timer.elapsedMilliseconds));
        logicalNow += step;
        for (const timer of timers) { timer.elapsedMilliseconds += step; }
        for (const timer of timers) {
            if (scheduledTimers.has(timer) && timer.elapsedMilliseconds >= timer.intervalMilliseconds) {
                timer.elapsedMilliseconds -= timer.intervalMilliseconds;
                await timer.callback();
            }
        }
    }
}

async function resetFixture(overrides = {}) {
    PickList.stopAutoRandomTask();
    scheduledTimers.clear();
    fs.rmSync(path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'rotation.json'), { force: true });
    globalState.clear();
    globalState.set('wallpaperStudioSourceMode', 'folder');
    appliedImages.length = 0;
    mockEnvironment.sessionId = 'auto-refresh-test';
    settings = {
        autoStatus: true,
        autoInterval: 600,
        imagePath: '',
        randomImageFolder: localFolder,
        perWindowBackground: true,
        opacity: 0,
        blur: 0,
        ...overrides
    };
    setContext({
        subscriptions: [],
        globalStorageUri: { fsPath: temporaryRoot },
        globalState: {
            get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
            update: async (key, value) => {
                if (value === undefined) { globalState.delete(key); }
                else { globalState.set(key, value); }
            }
        }
    });
    await setCurrentImagePath(localImages[0], { pin: false });
}

async function runTest(name, run) {
    try {
        await run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

async function main() {
    await runTest('autoStatus 关闭时不排定时器', async () => {
        await resetFixture({ autoStatus: false });
        PickList.startAutoRandomTask();
        assert.equal(scheduledTimers.size, 0);
    });

    await runTest('开启后按间隔触发且只在本模式内换图', async () => {
        await resetFixture();
        PickList.startAutoRandomTask();
        assert.equal(scheduledTimers.size, 1);
        await advanceTime(599000);
        assert.equal(appliedImages.length, 0);
        await advanceTime(1000);
        assert.equal(appliedImages.length, 1);
        assert.ok(
            localImages.includes(appliedImages[0].imagePath),
            `必须来自当前目录候选，实际: ${appliedImages[0].imagePath}`
        );
    });

    await runTest('连续两轮不会重复同一张', async () => {
        await resetFixture();
        PickList.startAutoRandomTask();
        await advanceTime(600000);
        await advanceTime(600000);
        assert.equal(appliedImages.length, 2);
        assert.notEqual(appliedImages[0].imagePath, appliedImages[1].imagePath);
    });

    await runTest('目录为空时不触发换图', async () => {
        const emptyFolder = path.join(temporaryRoot, 'empty');
        fs.mkdirSync(emptyFolder, { recursive: true });
        await resetFixture({ randomImageFolder: emptyFolder });
        PickList.startAutoRandomTask();
        await advanceTime(1200000);
        assert.equal(appliedImages.length, 0);
    });

    await runTest('轮播应用不弹确认提示（silent / randUpdate）', async () => {
        await resetFixture();
        PickList.startAutoRandomTask();
        await advanceTime(600000);
        assert.equal(appliedImages.length, 1);
        const applied = appliedImages[0];
        // silent=true 在 applyBackgroundPath 里转为 randUpdate=true；
        // 两者任一为真都表示"不向用户弹确认"。
        assert.ok(
            applied.silent === true || applied.randUpdate === true,
            `轮播必须静默，实际 silent=${applied.silent} randUpdate=${applied.randUpdate}`
        );
    });


    await runTest('固定优先于轮播，固定之间切换保持停止，普通切换恢复完整间隔', async () => {
        await resetFixture({ autoStatus: false, autoInterval: 0 });
        await PickList.setWallpaperPinned(localImages[0], true);
        assert.equal(getPinnedImagePath(), localImages[0]);
        assert.equal(scheduledTimers.size, 0);
        await PickList.setWallpaperPinned(localImages[1], true);
        assert.equal(getPinnedImagePath(), localImages[1]);
        assert.equal(settings.autoStatus, false);
        assert.equal(scheduledTimers.size, 0);
        assert.equal(await PickList.autoUpdateBackground(), false);
        await PickList.applyBackgroundPath(localImages[2]);
        assert.equal(getPinnedImagePath(), '');
        assert.equal(getPreviousImagePath(), localImages[1]);
        assert.equal(settings.autoStatus, true);
        assert.equal(settings.autoInterval, 60);
        assert.equal(scheduledTimers.size, 1);
        const count = appliedImages.length;
        await advanceTime(59000); assert.equal(appliedImages.length, count);
        await advanceTime(1000); assert.equal(appliedImages.length, count + 1);
    });

    await runTest('手动切换和自动切换均重置完整倒计时，取消固定恢复轮播', async () => {
        await resetFixture();
        PickList.startAutoRandomTask();
        await advanceTime(599000);
        await PickList.applyBackgroundPath(localImages[1]);
        await advanceTime(599000); assert.equal(appliedImages.length, 1);
        await advanceTime(1000); assert.equal(appliedImages.length, 2);
        await advanceTime(599000); assert.equal(appliedImages.length, 2);
        await PickList.setWallpaperPinned(localImages[0], true);
        await advanceTime(1200000); assert.equal(appliedImages.length, 3);
        await PickList.setWallpaperPinned(localImages[0], false);
        assert.equal(scheduledTimers.size, 1);
        await advanceTime(600000); assert.equal(appliedImages.length, 4);
    });

    await runTest('失败的切换保留固定、当前和上一张记录', async () => {
        await resetFixture();
        await PickList.setWallpaperPinned(localImages[0], true);
        const previous = getPreviousImagePath();
        const successfulUpdate = PickList.prototype.updateDom;
        try {
            PickList.prototype.updateDom = async () => ({ applied: false, requiresReload: false });
            assert.equal(await PickList.applyBackgroundPath(localImages[1]), false);
            assert.equal(getPinnedImagePath(), localImages[0]);
            assert.equal(getPreviousImagePath(), previous);
            assert.equal(scheduledTimers.size, 0);
        } finally { PickList.prototype.updateDom = successfulUpdate; }
    });

    PickList.prototype.updateDom = originalUpdateDom;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });

    if (failures) {
        console.error(`${failures} test(s) failed`);
        process.exitCode = 1;
    } else {
        console.log('All auto-refresh tests passed.');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

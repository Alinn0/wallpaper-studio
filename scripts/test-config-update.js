/** Run after compilation: node scripts/test-config-update.js */
'use strict';

const assert = require('assert').strict;
const Module = require('module');

const commands = new Map();
const globalState = new Map();
const applied = [];
const mockEnvironment = { sessionId: 'config-window', language: 'en' };
let settings = { imagePath: '', perWindowBackground: false };
let rejectWrite = false;
let modeApplies = 0;
let failures = 0;

class MockEventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = listener => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
    }
    fire(value) { this.listeners.forEach(listener => listener(value)); }
    dispose() { this.listeners.clear(); }
}

const configurationChanges = new MockEventEmitter();
function getConfiguration() {
    // VS Code returns a snapshot: update() must not mutate existing getters or properties.
    const snapshot = { ...settings };
    return Object.freeze({
        ...snapshot,
        get: (key, fallback) => snapshot[key] ?? fallback,
        update: async (key, value) => {
            await Promise.resolve();
            if (rejectWrite) { throw new Error('settings write failed'); }
            settings = { ...settings, [key]: value };
            configurationChanges.fire({
                affectsConfiguration: section => section === 'wallpaperStudio' || section === `wallpaperStudio.${key}`
            });
        }
    });
}

const disposable = () => ({ dispose() {} });
/** 设置变更事件：扩展现在监听扩展自有的全局设置文件，而不是 VS Code 配置。 */
const settingsChanges = new MockEventEmitter();
const mockSettingsStore = {
    // 与 src/settingsStore.ts 的 AppConfig 形状一致，但数据来自测试 fixture。
    getAppConfig: () => Object.freeze({
        ...settings,
        get: (key, fallback) => settings[key] ?? fallback,
        has: key => settings[key] !== undefined,
        inspect: key => ({ key, globalValue: settings[key] }),
        update: async (key, value) => {
            await Promise.resolve();
            if (rejectWrite) { throw new Error('settings write failed'); }
            settings = { ...settings, [key]: value };
            configurationChanges.fire({
                affectsConfiguration: section => section === 'wallpaperStudio' || section === `wallpaperStudio.${key}`
            });
            settingsChanges.fire([key]);
        }
    }),
    onDidChangeSettings: settingsChanges.event,
    readSettings: () => ({ ...settings }),
    DEFAULT_SETTINGS: {}
};
const mockVscode = {
    EventEmitter: MockEventEmitter,
    env: mockEnvironment,
    version: 'config-test',
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Right: 2 },
    workspace: { getConfiguration, onDidChangeConfiguration: configurationChanges.event },
    commands: {
        registerCommand: (name, handler) => {
            commands.set(name, handler);
            return disposable();
        },
        executeCommand: async (name, ...args) => commands.get(name)?.(...args)
    },
    window: {
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
        registerWebviewViewProvider: disposable,
        createTreeView: disposable,
        setStatusBarMessage: disposable,
        showInformationMessage: async () => undefined,
        showErrorMessage: message => { throw new Error(message); }
    },
    extensions: { getExtension: () => ({ packageJSON: { version: 'config-test' } }) }
};

// Keep the real command, per-window storage, PickList and Studio message handling.
// Replace only UI registration and the workbench file-writing boundary.
const originalLoad = Module._load;
Module._load = function (request, parent) {
    if (request === 'vscode') { return mockVscode; }
    if (request === './settingsStore') { return mockSettingsStore; }
    if (request === './FileDom') {
        return {
            CUSTOM_JS_FILE_PATH: __filename,
            detectPatchState: async () => 'latest',
            collectStaleWindowCssFiles: async () => {},
            FileDom: class {
                constructor(config, imagePath, opacity, sizeModel, blur, blendModel) {
                    this.values = { imagePath, opacity, sizeModel, blur, blendModel };
                }
                async install() { applied.push(this.values); return false; }
            }
        };
    }
    if (request === './wallpaperStudioView') {
        return { WallpaperStudioViewProvider: class {} };
    }
    if (request === './onlineCache' && /[\\/]out[\\/]extension\.js$/.test(parent.filename)) {
        return { pruneOnlineCache: async () => {} };
    }
    return originalLoad.apply(this, arguments);
};

let activate, PickList, StudioViewProvider;
try {
    ({ activate } = require('../out/extension'));
    ({ PickList } = require('../out/PickList'));
    ({ StudioViewProvider } = require('../out/StudioViewProvider'));
} finally {
    Module._load = originalLoad;
}

PickList.startAutoRandomTask = () => {};
PickList.autoUpdateBackground = () => {};
const { getSessionHash } = require('../out/windowBackground');
PickList.applyCurrentBackground = async () => { modeApplies++; return false; };

const context = {
    subscriptions: [],
    globalState: {
        get: (key, fallback) => globalState.get(key) ?? fallback,
        update: async (key, value) => { globalState.set(key, value); }
    }
};
const studio = new StudioViewProvider(context);
const setConfig = (key, value) => studio.handleMessage({ type: 'setConfig', key, value });

function resetFixture(perWindowBackground = false) {
    settings = { imagePath: '/test/wallpaper.png', opacity: 0.2, blur: 0,
        sizeModel: 'cover', blendModel: 'auto', perWindowBackground };
    globalState.clear();
    applied.length = 0;
    mockEnvironment.sessionId = 'config-window';
    rejectWrite = false;
    modeApplies = 0;
}

async function test(name, run) {
    resetFixture();
    try {
        await run();
        console.log(`PASS ${name}`);
    } catch (error) {
        failures++;
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

async function main() {
    globalState.set('ext_version', 'config-test');
    activate(context);
    // Let startup's asynchronous patch check finish before setting a test image.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(commands.has('wallpaperStudio.setConfig'));

    await test('configuration mock retains the original snapshot after saving', async () => {
        const before = getConfiguration();
        await before.update('opacity', 0.5);
        assert.equal(before.opacity, 0.2);
        assert.equal(before.get('opacity'), 0.2);
        assert.equal(getConfiguration().opacity, 0.5);
    });

    for (const perWindow of [false, true]) {
        for (const [key, values] of [['opacity', [0.5, 0.1, 0]], ['blur', [20, 60, 0]]]) {
            await test(`${perWindow ? 'per-window' : 'shared'} ${key} applies the current value on every change`, async () => {
                resetFixture(perWindow);
                for (const value of values) {
                    const count = applied.length;
                    await setConfig(key, value);
                    assert.equal(applied.length, count + 1);
                    assert.equal(applied[count][key], value, `applied ${key} must be ${value}`);
                    // 面板是唯一的入口：改完面板，配置文件里必须也是同一个值。
                    assert.equal(settings[key], value, `settings.json ${key} must follow the panel`);
                }
                // 另一个窗口没有自己的记录 → 回落到 settings.json（面板刚写进去的值）。
                mockEnvironment.sessionId = 'other-window';
                const otherWindow = new PickList(getConfiguration());
                assert.equal(otherWindow[key], values[values.length - 1]);
                // 透明度/模糊度现在是**全局共享**设置：即使 globalState 里还残留
                // 窗口级旧记录（按 profile 隔离），也必须被忽略 ——
                // 否则切换 profile 时会读到别的 profile 的旧值（曾导致透明度直接拉满）。
                if (perWindow) {
                    const recordKey = key === 'opacity' ? 'wallpaperStudio.windowOpacity' : 'wallpaperStudio.windowBlur';
                    globalState.set(recordKey, { [getSessionHash()]: 0.33 });
                    assert.equal(
                        new PickList(getConfiguration())[key],
                        values[values.length - 1],
                        'window-level records must not override the shared setting'
                    );
                }
            });
        }
    }

    for (const [key, values] of [['sizeModel', ['contain', 'repeat']], ['blendModel', ['multiply', 'lighten']]]) {
        await test(`${key} uses fresh configuration after saving`, async () => {
            for (const value of values) {
                const count = applied.length;
                await setConfig(key, value);
                assert.equal(applied.length, count + 1);
                assert.equal(applied[count][key], value);
            }
        });
    }

    await test('shared opacity and blur changes preserve each other', async () => {
        await setConfig('opacity', 0.5);
        await setConfig('blur', 20);
        await setConfig('opacity', 0.1);
        assert.deepEqual(applied.map(({ opacity, blur }) => ({ opacity, blur })), [
            { opacity: 0.5, blur: 0 }, { opacity: 0.5, blur: 20 }, { opacity: 0.1, blur: 20 }
        ]);
    });

    await test('failed settings writes do not apply a background', async () => {
        rejectWrite = true;
        for (const [key, value] of [['opacity', 0.5], ['blur', 20], ['sizeModel', 'contain']]) {
            await assert.rejects(setConfig(key, value), /settings write failed/);
        }
        assert.equal(applied.length, 0);
        assert.equal(settings.opacity, 0.2);
        assert.equal(settings.blur, 0);
        assert.equal(settings.sizeModel, 'cover');
    });

    await test('mode switch is applied once by the configuration listener', async () => {
        for (const enabled of [true, false]) {
            await setConfig('perWindowBackground', enabled);
            assert.equal(settings.perWindowBackground, enabled);
        }
        assert.equal(modeApplies, 2);
        assert.equal(applied.length, 0);
    });

    console.log(`\n${failures ? 'FAIL' : 'PASS'} config update regression tests (${failures} failures)`);
    if (failures) { process.exitCode = 1; }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    context.subscriptions.forEach(subscription => subscription.dispose?.());
    configurationChanges.dispose();
});

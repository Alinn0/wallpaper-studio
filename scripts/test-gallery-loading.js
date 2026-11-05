/**
 * 壁纸列表加载进度回归测试（扩展侧消息序列）。
 *
 * 背景：面板进入「壁纸列表」页时触发加载，但用户看到的是
 * 「先短暂显示加载 → 又变回『播放列表没有壁纸』 → 最后列表突然全部出现」。
 * 这说明加载期间有一条 state 消息把 loading 抹成 false，而列表还是空的。
 *
 * 本测试把 StudioViewProvider 跑在 Node 里，记录它发给面板的每一条消息，
 * 断言整个加载过程中不会出现「loading=false 且列表为空」的空窗。
 *
 * Run after compilation: node scripts/test-gallery-loading.js
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-gallery-loading-'));
const ITEM_COUNT = 60;
const user = os.userInfo().username;

// ---- fixture：一个带 60 个场景包的 Wallpaper Engine 播放列表 -------------------
const items = [];
for (let i = 0; i < ITEM_COUNT; i += 1) {
    const itemPath = path.join(tempRoot, `scene-${i}.pkg`);
    fs.writeFileSync(itemPath, 'x');
    items.push(itemPath);
}
const configPath = path.join(tempRoot, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
    [user]: {
        general: {
            wallpaperconfig: {
                selectedwallpapers: {
                    Monitor0: { playlist: { items } }
                }
            }
        }
    }
}), 'utf8');

// ---- vscode / 依赖桩 --------------------------------------------------------
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

const globalState = new Map();
const settings = { imagePath: '', sizeModel: 'cover', blendModel: 'auto', opacity: 1, blur: 0 };
const settingsChanges = new MockEventEmitter();
const globalStateChanges = new MockEventEmitter();

const mockSettingsStore = {
    getAppConfig: () => Object.freeze({
        ...settings,
        get: (key, fallback) => settings[key] ?? fallback,
        has: key => settings[key] !== undefined,
        inspect: key => ({ key, globalValue: settings[key] }),
        update: async (key, value) => {
            settings[key] = value;
            settingsChanges.fire([key]);
        }
    }),
    onDidChangeSettings: settingsChanges.event,
    readSettings: () => ({ ...settings }),
    resetSettings: async () => {},
    DEFAULT_SETTINGS: {}
};

const disposable = () => ({ dispose() {} });
const mockVscode = {
    EventEmitter: MockEventEmitter,
    env: { sessionId: 'gallery-test', language: 'en', appHost: 'desktop', uiKind: 1 },
    version: 'test',
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Right: 2 },
    ViewColumn: { One: 1 },
    Uri: {
        file: value => ({
            fsPath: value,
            path: value,
            scheme: 'file',
            toString: () => `file://${value}`,
            with: () => ({ fsPath: value, toString: () => `file://${value}` })
        }),
        joinPath: (base, ...parts) => {
            const joined = path.join(base.fsPath || String(base), ...parts);
            return { fsPath: joined, path: joined, scheme: 'file', toString: () => `file://${joined}` };
        },
        parse: value => ({ fsPath: value, path: value, scheme: 'file', toString: () => value })
    },
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => settings[key] ?? fallback,
            inspect: () => undefined,
            update: async () => {}
        }),
        onDidChangeConfiguration: () => disposable()
    },
    commands: { registerCommand: () => disposable(), executeCommand: async () => {} },
    window: {
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
        registerWebviewViewProvider: disposable,
        createTreeView: disposable,
        setStatusBarMessage: disposable,
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showOpenDialog: async () => undefined
    },
    extensions: { getExtension: () => ({ packageJSON: { version: 'test' } }) }
};

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') { return mockVscode; }
    if (request === './settingsStore') { return mockSettingsStore; }
    if (request === './global') {
        return {
            getContext: () => ({ globalState: context.globalState }),
            onDidChangeGlobalState: globalStateChanges
        };
    }
    if (request === './FileDom') {
        return {
            CUSTOM_JS_FILE_PATH: __filename,
            detectPatchState: async () => 'latest',
            collectStaleWindowCssFiles: async () => {},
            FileDom: class {
                async install() { return false; }
            }
        };
    }
    if (request === './wallpaperStudioView') {
        return { WallpaperStudioViewProvider: class {} };
    }
    return originalLoad.apply(this, arguments);
};

let StudioViewProvider;
let PickList;
try {
    ({ StudioViewProvider } = require('../out/StudioViewProvider'));
    ({ PickList } = require('../out/PickList'));
} finally {
    Module._load = originalLoad;
}

PickList.startAutoRandomTask = () => {};
PickList.autoUpdateBackground = () => {};
PickList.applyCurrentBackground = async () => false;
PickList.applySceneProperties = async () => true;

// ---- context / view ---------------------------------------------------------
const context = {
    subscriptions: [],
    extensionPath: ROOT,
    extensionUri: { fsPath: ROOT, path: ROOT, scheme: 'file', toString: () => `file://${ROOT}` },
    storageUri: { fsPath: path.join(tempRoot, 'ws-storage') },
    globalStorageUri: { fsPath: path.join(tempRoot, 'storage') },
    globalState: {
        get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
        update: async (key, value) => {
            globalState.set(key, value);
            globalStateChanges.fire({ key, value });
        }
    }
};

const posted = [];
let messageHandler;
function makeView() {
    const webview = {
        options: {},
        cspSource: 'vscode-webview://test',
        html: '',
        postMessage: message => { posted.push({ at: Date.now(), message }); return Promise.resolve(true); },
        asWebviewUri: uri => ({ toString: () => (uri && uri.toString ? uri.toString() : String(uri)) }),
        onDidReceiveMessage: handler => { messageHandler = handler; return disposable(); }
    };
    return { webview, onDidDispose: listener => { void listener; return disposable(); } };
}

function summaries() {
    return posted.map(entry => {
        const message = entry.message || {};
        if (message.type === 'state') {
            const state = message.data && message.data.state ? message.data.state : {};
            return {
                type: 'state',
                loading: state.wallpaperLoading === true,
                playlist: Array.isArray(state.wallpaperPlaylist) ? state.wallpaperPlaylist.length : 0,
                sourceMode: state.sourceMode
            };
        }
        if (message.type === 'wallpaper-loading') {
            return { type: 'progress', loading: message.loading === true, loaded: message.loaded, total: message.total };
        }
        return { type: message.type };
    });
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function resetFixture() {
    globalState.clear();
    globalState.set('wallpaperStudioWallpaperConfig', configPath);
    globalState.set('wallpaperStudioWallpaperEnabled', true);
    globalState.set('wallpaperStudioSourceMode', 'wallpaper');
    // 跳过一次性默认模式迁移，模拟已经用过的用户。
    globalState.set('wallpaperStudioDefaultModeWallpaper', true);
    settings.imagePath = items[0];
    posted.length = 0;
}

/** 断言：加载态出现之后、带列表的 state 之前，不能出现「loading=false 且空列表」。 */
function assertNoBlankWindow(log, label) {
    const states = log.filter(entry => entry.type === 'state');
    assert.ok(states.length > 0, `${label}: 必须推送过 state`);
    const firstState = states[0];
    assert.ok(
        !(firstState.loading === false && firstState.playlist === 0),
        `${label}: 第一条 state 就声称「加载完毕且没有壁纸」，面板会闪一次空态：${JSON.stringify(firstState)}`
    );
    const firstLoading = log.findIndex(entry => (entry.type === 'progress' && entry.loading) || (entry.type === 'state' && entry.loading));
    assert.ok(firstLoading >= 0, `${label}: 触发加载后必须立刻推送加载态`);
    const finalIndex = log.findIndex(entry => entry.type === 'state' && !entry.loading && entry.playlist > 0);
    assert.ok(finalIndex > firstLoading, `${label}: 最后必须有一条带完整列表的 state`);
    for (let i = firstLoading; i < finalIndex; i += 1) {
        const entry = log[i];
        const blank = entry.type === 'state' && !entry.loading && entry.playlist === 0;
        assert.ok(!blank, `${label}: 加载过程中出现空窗消息（第 ${i} 条）：${JSON.stringify(log)}`);
    }
    return finalIndex;
}

/**
 * 断言：加载期间的进度消息必须真的在推进。
 *
 * 解析本身很快时（缓存命中）只有首尾两帧是正常的；这条断言针对「解析很慢」的
 * 情况：按间隔连续调用进度上报，必须周期性发出消息且计数在变。
 */
async function assertProgressThrottle(provider, label) {
    posted.length = 0;
    provider.wallpaperLoading = true;
    provider.wallpaperTotal = 100;
    for (let loaded = 0; loaded <= 100; loaded += 5) {
        provider.wallpaperLoaded = loaded;
        provider.pushWallpaperLoadingProgress(loaded === 0);
        await wait(5);
    }
    await wait(120);
    const progress = summaries().filter(entry => entry.type === 'progress');
    assert.ok(progress.length >= 3, `${label}: 进度消息太少（${progress.length} 条），节流实现可能被写成了防抖`);
    const values = progress.map(entry => entry.loaded).filter(value => typeof value === 'number');
    for (let i = 1; i < values.length; i += 1) {
        assert.ok(values[i] >= values[i - 1], `${label}: 进度不能倒退：${JSON.stringify(values)}`);
    }
    assert.ok(new Set(values).size >= 3, `${label}: 进度值必须真的在变化，实际只有 ${[...new Set(values)].join(',')}`);
    const last = values[values.length - 1];
    assert.ok(last >= 100, `${label}: 最后一次进度必须追上最终计数，实际 ${last}`);
}

async function scenario(label, run) {
    resetFixture();
    const provider = new StudioViewProvider(context);
    await run(provider);
    const log = summaries();
    console.log(`\n[${label}] message sequence:`);
    for (const entry of log) { console.log('  ' + JSON.stringify(entry)); }
    return log;
}

(async () => {
    // 场景 A：启动同步已结束，用户随后切到壁纸列表页。
    const logA = await scenario('A 列表页按需加载', async provider => {
        provider.resolveWebviewView(makeView(), {}, { cancellationToken: {} });
        for (let i = 0; i < 100; i += 1) {
            await wait(50);
            if (summaries().some(entry => entry.type === 'state' && entry.playlist > 0)) { break; }
        }
        posted.length = 0;
        await provider.handleMessage({ type: 'loadGallery' });
        await wait(300);
    });

    // 场景 B：刚打开面板（启动同步还在跑）就切到列表页。
    const logB = await scenario('B 启动同步未完成就切列表', async provider => {
        provider.resolveWebviewView(makeView(), {}, { cancellationToken: {} });
        await provider.handleMessage({ type: 'loadGallery' });
        await wait(600);
    });

    // 场景 C：面板恢复到最后停留的列表页（ready 与 loadGallery 同时到）。
    const logC = await scenario('C 恢复列表页', async provider => {
        provider.resolveWebviewView(makeView(), {}, { cancellationToken: {} });
        await Promise.all([
            provider.handleMessage({ type: 'ready' }),
            provider.handleMessage({ type: 'loadGallery' })
        ]);
        await wait(600);
    });

    for (const [label, log] of [['A', logA], ['B', logB], ['C', logC]]) {
        assertNoBlankWindow(log, label);
    }

    // 节流语义：连续上报时消息必须周期性发出，计数要真的推进。
    resetFixture();
    const throttleProvider = new StudioViewProvider(context);
    throttleProvider.resolveWebviewView(makeView(), {}, { cancellationToken: {} });
    await wait(100);
    await assertProgressThrottle(throttleProvider, 'D 进度节流');

    console.log('\nAll gallery loading tests passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

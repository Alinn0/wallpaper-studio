/**
 * 来源模式隔离回归测试。
 *
 * 背景：随机 / 定时轮播曾经跨模式取图 —— 当前是 Wallpaper 配置模式，
 * 定时器却从 randomImageFolder 抽图。根因是"当前模式"有两套判定：
 * 面板看 wallpaperStudioSourceMode，PickList 只看 wallpaperStudioWallpaperEnabled。
 *
 * 本测试固定 sourceMode.getCandidatesForMode() 的行为：三种模式各自只能返回
 * 本模式内的候选，且 file 模式要排除播放列表项与目录内文件。
 *
 * Run after compilation: node scripts/test-source-isolation.js
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-source-iso-'));

// ---- fixture ----------------------------------------------------------------
const folderDir = path.join(tempRoot, 'folder');
fs.mkdirSync(folderDir, { recursive: true });
const folderFileA = path.join(folderDir, 'folder-a.png');
const folderFileB = path.join(folderDir, 'folder-b.mp4');
fs.writeFileSync(folderFileA, 'x');
fs.writeFileSync(folderFileB, 'x');

const workshopDir = path.join(tempRoot, 'workshop');
fs.mkdirSync(workshopDir, { recursive: true });
const sceneA = path.join(workshopDir, 'scene-a.pkg');
const sceneB = path.join(workshopDir, 'scene-b.pkg');
fs.writeFileSync(sceneA, 'x');
fs.writeFileSync(sceneB, 'x');

const configPath = path.join(tempRoot, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
    Tester: {
        general: {
            wallpaperconfig: {
                selectedwallpapers: {
                    Monitor0: { playlist: { items: [sceneA, sceneB] } }
                }
            }
        }
    }
}), 'utf8');

const standaloneFile = path.join(tempRoot, 'standalone.png');
fs.writeFileSync(standaloneFile, 'x');

// ---- vscode / 依赖桩 --------------------------------------------------------
const settings = { randomImageFolder: folderDir, imagePath: '', autoStatus: true, autoInterval: 10 };
const globalState = new Map();

const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') {
        class Emitter {
            constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
            fire(value) { this.listeners.forEach(fn => fn(value)); }
            dispose() { this.listeners.clear(); }
        }
        return {
            EventEmitter: Emitter,
            workspace: {},
            env: { appHost: 'desktop', uiKind: 1 },
            Uri: { file: p => ({ fsPath: p, toString: () => `file://${p}` }) },
            window: {
                createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
                showWarningMessage() {},
                showErrorMessage() {},
                setStatusBarMessage: () => ({ dispose() {} }),
                showInformationMessage: async () => undefined
            },
            commands: { executeCommand: async () => {} },
            ConfigurationTarget: { Global: 1 },
            StatusBarAlignment: { Right: 2 },
            UIKind: { Desktop: 1, Web: 2 },
            extensions: { getExtension: () => undefined }
        };
    }
    if (request === './global') {
        const context = {
            subscriptions: [],
            extensionUri: { fsPath: tempRoot },
            globalStorageUri: { fsPath: tempRoot },
            globalState: {
                get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
                update: async (key, value) => {
                    if (value === undefined) { globalState.delete(key); }
                    else { globalState.set(key, value); }
                }
            }
        };
        return {
            getContext: () => context,
            setContext: () => context,
            onDidChangeGlobalState: { event: () => ({ dispose() {} }), fire() {} }
        };
    }
    if (request === './settingsStore') {
        return {
            getAppConfig: () => ({
                ...settings,
                get: (key, fallback) => (settings[key] !== undefined ? settings[key] : fallback),
                has: key => settings[key] !== undefined,
                inspect: key => ({ key, globalValue: settings[key] }),
                update: async (key, value) => { settings[key] = value; }
            }),
            onDidChangeSettings: () => ({ dispose() {} }),
            readSettings: () => ({ ...settings }),
            DEFAULT_SETTINGS: {}
        };
    }
    return originalLoad.apply(this, arguments);
};

const sourceMode = require('../out/sourceMode');
Module._load = originalLoad;

const names = list => list.map(item => path.basename(item)).sort();
let failures = 0;

function check(label, condition, detail) {
    if (condition) {
        console.log(`PASS ${label}`);
        return;
    }
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

function reset() {
    globalState.clear();
    globalState.set('wallpaperStudioWallpaperConfig', configPath);
    globalState.set('wallpaperStudioRecentImages', [standaloneFile, sceneA, sceneB, folderFileA]);
}

// ---- 用例 -------------------------------------------------------------------
reset();
globalState.set('wallpaperStudioSourceMode', 'wallpaper');
const wallpaperCandidates = sourceMode.getCandidatesForMode();
check(
    'wallpaper 模式只返回播放列表项目',
    names(wallpaperCandidates).join(',') === 'scene-a.pkg,scene-b.pkg',
    names(wallpaperCandidates).join(',')
);
check(
    'wallpaper 模式不含目录内文件',
    !wallpaperCandidates.some(item => path.normalize(item).startsWith(path.normalize(folderDir)))
);

reset();
globalState.set('wallpaperStudioSourceMode', 'folder');
const folderCandidates = sourceMode.getCandidatesForMode();
check(
    'folder 模式只返回目录内文件',
    names(folderCandidates).join(',') === 'folder-a.png,folder-b.mp4',
    names(folderCandidates).join(',')
);
check(
    'folder 模式不含播放列表项目',
    !folderCandidates.some(item => item === sceneA || item === sceneB)
);

reset();
globalState.set('wallpaperStudioSourceMode', 'file');
const fileCandidates = sourceMode.getCandidatesForMode();
check(
    'file 模式只返回单独导入的文件',
    names(fileCandidates).join(',') === 'standalone.png',
    names(fileCandidates).join(',')
);
check(
    'file 模式不含播放列表项目',
    !fileCandidates.some(item => item === sceneA || item === sceneB)
);
check(
    'file 模式不含目录内文件',
    !fileCandidates.some(item => path.normalize(item).startsWith(path.normalize(folderDir)))
);

// 移除记录后不再出现在候选中
reset();
globalState.set('wallpaperStudioSourceMode', 'folder');
globalState.set('wallpaperStudioFolderRemoved', [folderFileA]);
const afterRemoval = sourceMode.getCandidatesForMode();
check(
    '已移除的目录文件不再参与随机',
    !afterRemoval.some(item => item === folderFileA),
    names(afterRemoval).join(',')
);

// 随机排除当前项
reset();
globalState.set('wallpaperStudioSourceMode', 'folder');
const pool = sourceMode.getRandomCandidates(folderFileA);
check(
    '随机候选排除当前壁纸',
    !pool.some(item => item === folderFileA) && pool.length === 1,
    names(pool).join(',')
);

// 模式默认值与规范化
reset();
check('缺少模式记录时默认 wallpaper', sourceMode.getSourceMode() === 'wallpaper');
globalState.set('wallpaperStudioSourceMode', 'nonsense');
check('非法模式值回落到默认', sourceMode.getSourceMode() === 'wallpaper');

// 历史键随模式同步
reset();
globalState.set('wallpaperStudioWallpaperEnabled', true);
sourceMode.setSourceMode('folder').then(() => {
    check('切到 folder 时同步关闭播放列表标记', globalState.get('wallpaperStudioWallpaperEnabled') === false);
    return sourceMode.setSourceMode('wallpaper');
}).then(() => {
    check('切回 wallpaper 时同步开启播放列表标记', globalState.get('wallpaperStudioWallpaperEnabled') === true);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (failures) {
        console.error(`${failures} test(s) failed`);
        process.exitCode = 1;
    } else {
        console.log('All source-isolation tests passed.');
    }
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

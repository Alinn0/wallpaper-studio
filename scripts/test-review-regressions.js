'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

function load(file, stubs = {}, globals = {}) {
    const filename = path.resolve(file);
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports,
        require: name => Object.hasOwn(stubs, name) ? stubs[name] : nativeRequire(name),
        console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, ...globals
    }, { filename });
    return module.exports;
}
class Emitter {
    constructor() {
        this.listeners = new Set();
        this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
    }
    fire(value) { this.listeners.forEach(fn => fn(value)); }
}
let failures = 0;
async function test(name, run) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}:`, error); }
}

async function main() {
    await test('failed and superseded applications never persist; explicit empty path clears', async () => {
        let current = 'old.png', behavior = 'throw';
        const saves = [], notices = [], domOptions = [], pending = new Map();
        const gs = new Map();
        const config = { imagePath: '', opacity: 0.2, blur: 0, sizeModel: 'cover', get: (key, fallback) => config[key] ?? fallback };
        const stubs = {
            vscode: { window: { showErrorMessage: async text => notices.push(text),
                setStatusBarMessage: () => ({ dispose() {} }) }, commands: {}, ConfigurationTarget: { Global: 1 } },
            './FileDom': { FileDom: class {
                constructor(...args) { this.image = args[1]; this.requiresReload = false; domOptions.push(args); }
                async install() {
                    if (behavior === 'throw') { throw Error('install failed'); }
                    if (behavior === 'pending') { return new Promise(resolve => pending.set(this.image, resolve)); }
                    return behavior === 'success';
                }
                async clearBackground() { return true; }
            } },
            './global': { getContext: () => ({ globalState: {
                get: (key, fallback) => gs.get(key) ?? fallback,
                update: async (key, value) => gs.set(key, value)
            } }) },
            './windowBackground': { getWorkspaceKey: () => 'workspace', resolveCurrentImagePath: () => current,
                resolveCurrentOpacity: value => value, resolveCurrentBlur: value => value,
                setCurrentImagePath: async (value, options) => {
                    if (!options.shouldPersist || options.shouldPersist()) { saves.push(value); current = value; }
                } },
            './settingsStore': { getAppConfig: () => config }, './sourceMode': {}, './vsHelp': {}
        };
        const { PickList } = load('out/PickList.js', stubs, { setTimeout: () => 0 });
        await assert.rejects(PickList.applyBackgroundPath('bad.png', { silent: true }), /install failed/);
        assert.equal(domOptions.at(-1)[7], true);
        assert.equal(notices.length, 0);
        assert.deepEqual(saves, []);
        assert.equal(await PickList.applyBackgroundPath('bad.png'), false);
        assert.equal(notices.length, 1);
        behavior = 'failed';
        assert.equal(await PickList.applyBackgroundPath('bad.png'), false);
        assert.deepEqual(saves, []);
        behavior = 'success';
        assert.equal(await PickList.applyBackgroundPath('good.png'), true);
        assert.equal(current, 'good.png');
        assert.equal(await PickList.applyBackgroundPath(''), true);
        assert.equal(current, '');
        behavior = 'pending';
        const old = PickList.applyBackgroundPath('slow.png');
        const fresh = PickList.applyBackgroundPath('fresh.png');
        pending.get('fresh.png')(true);
        assert.equal(await fresh, true);
        pending.get('slow.png')(true);
        assert.equal(await old, false);
        assert.equal(current, 'fresh.png');
        assert.ok(!saves.includes('slow.png'));
    });

    await test('settings synchronize, merge concurrent writes, and roll back on disk failure', async () => {
        const filename = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'settings.json');
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, JSON.stringify({ version: 3, seeded: true, opacity: 0.2, blur: 0 }));
        const A = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
        const B = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
        assert.equal(A.readSettings().opacity, 0.2);
        await B.getAppConfig().update('opacity', 0.6);
        let external = [];
        A.onDidChangeExternalSettings(keys => { external.push(...keys); });
        A.reloadExternalSettings();
        assert.equal(A.readSettings().opacity, 0.6);
        assert.ok(external.includes('opacity'));
        await Promise.all([A.getAppConfig().update('opacity', 0.4), B.getAppConfig().update('blur', 12)]);
        let disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
        assert.equal(disk.opacity, 0.4);
        assert.equal(disk.blur, 12);
        assert.equal(disk.version, 3);
        const brokenFs = { ...fs, renameSync() { throw Object.assign(Error('disk failure'), { code: 'EPERM' }); } };
        const failed = load('out/settingsStore.js', { fs: brokenFs, vscode: { EventEmitter: Emitter },
            './atomicWrite': load('out/atomicWrite.js', { fs: brokenFs }) });
        assert.equal(failed.readSettings().opacity, 0.4);
        await assert.rejects(failed.getAppConfig().update('opacity', 0.7), /Failed to save/);
        assert.equal(failed.readSettings().opacity, 0.4);
        disk = JSON.parse(fs.readFileSync(filename, 'utf8'));
        assert.equal(disk.opacity, 0.4);
        assert.equal(fs.readdirSync(path.dirname(filename)).filter(name => name.endsWith('.tmp')).length, 0);
        const subscription = A.startSettingsSync();
        try {
            await new Promise(resolve => setTimeout(resolve, 80));
            const changed = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Error('settings watcher timed out')), 4000);
                const stop = A.onDidChangeExternalSettings(keys => {
                    if (keys.includes('blur')) { clearTimeout(timer); stop.dispose(); resolve(); }
                });
            });
            await B.getAppConfig().update('blur', 25);
            await changed;
            assert.equal(A.readSettings().blur, 25);
        } finally { subscription.dispose(); }
    });

    await test('runtime mutator executes once and failed atomic replacement preserves disk', async () => {
        const globals = { getContext: () => ({ globalState: { get: (key, fallback) => fallback } }) };
        const runtime = load('out/runtimeStore.js', { './global': globals });
        let calls = 0;
        assert.equal(await runtime.updateRuntimeState(state => { calls++; state.workspaceImages.test = 'good.png'; }), true);
        assert.equal(calls, 1);
        const brokenFs = { ...fs, renameSync() { throw Error('simulated rename failure'); } };
        const failed = load('out/runtimeStore.js', { './global': globals,
            './atomicWrite': load('out/atomicWrite.js', { fs: brokenFs }) });
        assert.equal(await failed.updateRuntimeState(state => { state.workspaceImages.test = 'bad.png'; }), false);
        assert.equal(runtime.readRuntimeState().workspaceImages.test, 'good.png');
    });

    await test('playlist race rejects stale results; previous stays in its source; refresh reads data', async () => {
        const pending = new Map(), cache = [], commands = [];
        const history = ['C:/local.png', 'C:/playlist/scene.pkg', 'C:/older.png'];
        const gs = { get: (key, fallback) => key === 'wallpaperStudioRecentImages' ? history
            : key === 'wallpaperStudioWallpaperUser' ? 'user' : fallback, update: async () => {} };
        const engine = { WALLPAPER_USER_KEY: 'wallpaperStudioWallpaperUser',
            resolveActiveWallpaperUser: () => ({ user: 'user' }), clearWallpaperProjectCache() {}, forgetWallpaperPlaylist() {},
            readRemovedWallpapers: () => [], readWallpaperPlaylistAsync: key => new Promise(resolve => pending.set(key, resolve)),
            rememberWallpaperPlaylist: (config, removed, user, entries) => cache.push({ config, paths: entries.map(entry => entry.path) }) };
        const stubs = { fs: { existsSync: () => true }, vscode: { commands: { executeCommand: async (...args) => commands.push(args) } },
            './PickList': {}, './global': {}, './windowBackground': { resolveCurrentImagePath: () => history[0] },
            './settingsStore': { getAppConfig: () => ({ get: (key, fallback) => fallback }) },
            './sourceMode': { normalizeSourceMode: value => value, getCandidatesForMode: () => [history[0], history[2]] },
            './thumbnailStore': {}, './scenePreview': {}, './wallpaperEngine': engine, './runtimeStore': {} };
        const { StudioViewProvider } = load('out/StudioViewProvider.js', stubs);
        const object = Object.create(StudioViewProvider.prototype);
        Object.assign(object, { ctx: { globalState: gs }, sourceMode: 'file', wallpaperSyncGeneration: 0,
            wallpaperConfigPath: 'old.json', wallpaperUser: 'user', pushWallpaperLoadingProgress() {}, pushState() {} });
        await object.handleMessage({ type: 'previousWallpaper' });
        assert.equal(commands[0][2], history[2]);
        const old = object.syncWallpaperPlaylist();
        object.wallpaperConfigPath = 'new.json';
        const fresh = object.syncWallpaperPlaylist(true);
        pending.get('new.json')([{ path: 'NEW.pkg' }]); await fresh;
        pending.get('old.json')([{ path: 'OLD.pkg' }]); await old;
        assert.equal(object.wallpaperEntries[0].path, 'NEW.pkg');
        assert.equal(cache.at(-1).config, 'new.json');
        assert.equal(cache.at(-1).paths[0], 'NEW.pkg');
        let syncs = 0, pushes = 0;
        object.syncWallpaperPlaylist = async force => { assert.equal(force, true); syncs++; };
        object.pushState = () => pushes++;
        object.folderCache = { stale: true };
        await object.refresh();
        assert.equal(syncs, 1); assert.equal(pushes, 1); assert.equal(object.folderCache, undefined);
    });

    await test('property debounce snapshots the original wallpaper and values', () => {
        const source = fs.readFileSync('webview/src/views/HomeTab.vue', 'utf8');
        const names = ['updateWallpaperProperty', 'onPropertySliderInput', 'onViewOffsetInput'];
        const code = names.map(name => source.match(new RegExp('function ' + name + '\\([^]*?\\n}'))[0]).join('\n');
        const ts = require('typescript'), timers = [], messages = [];
        const box = { config: { imagePath: 'A.pkg' }, bridge: { post: value => messages.push(value) },
            propertyTimers: new Map(), setTimeout: callback => (timers.push(callback), timers.length), clearTimeout() {},
            cameraPanX: { value: 20 }, cameraPanY: { value: 50 }, PAN_MIN: 0, PAN_MAX: 200,
            clampRange: (value, min, max) => Math.min(max, Math.max(min, value)), Date, xyDirtyUntil: 0, viewOffsetTimer: undefined };
        vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, box);
        const property = { key: 'speed', value: 9 };
        box.onPropertySliderInput(property); box.onViewOffsetInput();
        property.value = 2; box.config.imagePath = 'B.pkg'; box.cameraPanX.value = 100;
        timers.forEach(callback => callback());
        assert.equal(messages[0].path, 'A.pkg'); assert.equal(messages[0].value, 9);
        assert.equal(messages[1].path, 'A.pkg'); assert.equal(messages[1].properties.wallpaperstudio_pan_x, 20);
    });

    await test('media detection and image/video pan use the original local path', async () => {
        const engine = require('../out/wallpaperEngine');
        const gsMap = new Map();
        const gs = { get: (key, fallback) => gsMap.get(key) ?? fallback, update: async (key, value) => gsMap.set(key, value) };
        await engine.setWallpaperProperty(gs, 'C:/pics/a.png', 'wallpaperstudio_pan_x', 0);
        const { FileDom } = load('out/FileDom.js', {
            vscode: { env: { appRoot: 'C:/virtual', uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 } },
            './global': { getContext: () => ({ globalState: gs }) }, './windowBackground': {}, './SudoPromptHelper': {},
            './settingsStore': { SETTINGS_DIR: process.env.WALLPAPER_STUDIO_DATA_DIR }
        });
        const object = Object.create(FileDom.prototype);
        Object.assign(object, { imagePath: 'vscode-file://vscode-app/C:/pics/a.png', mediaSourcePath: 'C:/pics/a.png',
            imageOpacity: 0.2, sizeModel: 'cover', blur: 0, blendModel: 'lighten' });
        assert.match(object.getCss(), /background-position: 0% 50%/);
        object.isVideo = true;
        assert.match(object.getCss(), /"position":"0% 50%"/);
        const detect = require('../out/pathUtil').isVideoFile;
        for (const ext of require('../out/mediaTypes').VIDEO_EXTS) {
            assert.equal(detect('a' + ext), true);
            assert.equal(engine.classifyWallpaperPath('a' + ext), 'video');
        }
        const compare = load('out/pathComparison.js', {}, { process: { platform: 'linux' } });
        assert.notEqual(compare.normalizeComparablePath('/work/A'), compare.normalizeComparablePath('/work/a'));
    });

    await test('protected writes elevate only one file; silent writes never elevate', async () => {
        const commands = [];
        const { FileDom } = load('out/FileDom.js', {
            vscode: { env: { appRoot: 'C:/virtual', uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 } },
            './global': {}, './windowBackground': {}, './settingsStore': { SETTINGS_DIR: process.env.WALLPAPER_STUDIO_DATA_DIR },
            'fs-extra': { writeFile: async () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); } },
            './SudoPromptHelper': { SudoPromptHelper: { exec: async command => commands.push(command) } }
        });
        const object = Object.create(FileDom.prototype);
        object.silent = true;
        await assert.rejects(object.writeWithPermission('C:/virtual/one.css', 'css'), /denied/);
        assert.equal(commands.length, 0);
        object.silent = false;
        await object.writeWithPermission('C:/virtual/one.css', 'css');
        assert.equal(commands.length, 1);
        if (process.platform === 'win32') {
            const script = Buffer.from(commands[0].split(' ').at(-1), 'base64').toString('utf16le');
            assert.match(script, /Copy-Item -LiteralPath/);
            assert.ok(script.includes("-Destination 'C:/virtual/one.css'"));
            assert.ok(!/icacls|takeown|chmod/i.test(script));
        } else { assert.match(commands[0], /^cp -f /); }
    });

    await test('desktop scene URL stays inside the protocol app root while hash metadata stays in user storage', async () => {
        const appRoot = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'protocol-app');
        const source = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'protocol-scene.pkg');
        const header = Buffer.alloc(12);
        header.writeUInt32LE(8, 0);
        header.write('PKGV0012', 4, 'ascii');
        fs.writeFileSync(source, header);
        const { FileDom } = load('out/FileDom.js', {
            vscode: {
                env: { appRoot, uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 },
                Uri: { file: file => ({ with: () => ({ toString: () => 'vscode-file://vscode-app' + file.replace(/\\/g, '/') }) }) }
            },
            './global': { getContext: () => ({ extensionPath: path.resolve('.') }) },
            './windowBackground': {}, './SudoPromptHelper': {},
            './settingsStore': { SETTINGS_DIR: process.env.WALLPAPER_STUDIO_DATA_DIR }
        });
        const object = Object.create(FileDom.prototype);
        object.wallpaperPkgSourcePath = source;
        let htmlPath;
        object.writeGeneratedTextFile = async file => { htmlPath = file; };
        await object.saveWallpaperSceneRuntimeContent();
        const assets = path.join(appRoot, 'out', 'vs', 'workbench', 'wallpaper-studio-assets');
        const packageFile = fs.readdirSync(assets).find(name => name.endsWith('.pkg'));
        assert.ok(packageFile, 'serve .pkg from the allowed app resource root');
        assert.equal(object.wallpaperSceneUrl, 'vscode-file://vscode-app' + path.join(assets, packageFile).replace(/\\/g, '/'));
        assert.deepEqual(fs.readFileSync(path.join(assets, packageFile)), header);
        assert.equal(path.dirname(htmlPath), path.dirname(assets));
        assert.ok(!fs.existsSync(path.join(assets, '.sources')), 'metadata must not require installation-directory writes');
        const indexes = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'scene-assets', '.sources');
        assert.ok(fs.readdirSync(indexes).some(name => name.endsWith('.json')));
    });

    await test('unchanged scene package is reused without rewriting the cached copy', async () => {
        const { copyWallpaperScenePackage } = require('../out/wallpaperScene');
        const source = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'sample.pkg');
        const assets = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'assets');
        fs.writeFileSync(source, 'sample package');
        const target = await copyWallpaperScenePackage(source, assets);
        fs.utimesSync(target, new Date(100000), new Date(100000));
        const before = fs.statSync(target).mtimeMs;
        assert.equal(await copyWallpaperScenePackage(source, assets), target);
        assert.equal(fs.statSync(target).mtimeMs, before);
        fs.writeFileSync(source, 'changed sample package');
        assert.notEqual(await copyWallpaperScenePackage(source, assets), target);
    });

    await test('concurrent thumbnail batches preserve both windows indexes', async () => {
        const { ThumbnailStore } = require('../out/thumbnailStore');
        const root = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'thumbs');
        const A = new ThumbnailStore(root), B = new ThumbnailStore(root);
        await Promise.all([A.setMany([['a', 'data:image/jpeg;base64,YQ=='], ['b', 'data:image/jpeg;base64,Yg==']]),
            B.setMany([['c', 'data:image/jpeg;base64,Yw==']])]);
        const restored = await new ThumbnailStore(root).snapshot();
        assert.deepEqual(Object.keys(restored).sort(), ['a', 'b', 'c']);
    });
    console.log(`Review regressions: ${failures} failed.`);
    process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });

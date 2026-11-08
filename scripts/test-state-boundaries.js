'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert').strict;
const { createRequire } = require('module');
const { once } = require('events');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-studio-audit-'));
process.env.WALLPAPER_STUDIO_DATA_DIR = path.join(scratch, 'state');
fs.mkdirSync(process.env.WALLPAPER_STUDIO_DATA_DIR);
const results = [];
function load(file, stubs = {}, globals = {}, source) {
    const filename = path.join(root, file), native = createRequire(filename), module = { exports: {} };
    const req = name => Object.hasOwn(stubs, name) ? stubs[name] : native(name);
    req.resolve = native.resolve;
    vm.runInNewContext(source || fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: req, process, Buffer, console,
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, AbortController, ...globals
    }, { filename });
    return module.exports;
}
class Emitter {
    constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(value) { this.listeners.forEach(fn => fn(value)); }
}
async function probe(name, action) { const detail = await action(); results.push({ name, ...detail }); }
async function main() {
    await probe('cancelled preparation cannot overwrite a later clear', async () => {
        const appRoot = path.join(scratch, 'app'), wb = path.join(appRoot, 'out/vs/workbench');
        fs.mkdirSync(wb, { recursive: true });
        const { FileDom } = load('out/FileDom.js', {
            vscode: { env: { appRoot, uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 }, window: { showErrorMessage: async () => {} } },
            os: { ...os, tmpdir: () => scratch }, './global': {}, './windowBackground': {}, './SudoPromptHelper': {}
        });
        let current = true, releaseCopy, started;
        const began = new Promise(resolve => started = resolve);
        const gate = new Promise(resolve => releaseCopy = resolve);
        const css = path.join(wb, 'test.css');
        const object = Object.create(FileDom.prototype);
        Object.assign(object, { shouldApply: () => current, windowCssFilePath: css, filePath: path.join(wb, 'main.js'),
            isWallpaperPkg: true, ensureInitialized: async () => {}, getCss: () => 'STALE_B_BACKGROUND',
            saveWallpaperSceneRuntimeContent: async () => { started(); await gate; },
            saveDynamicJsContent: async () => false, getJs: () => '/* bootstrap */',
            patchOneJsFile: async () => 'unchanged', saveCodeServerHtmlContent: async () => false,
            writeWithPermission: (file, text) => fs.promises.writeFile(file, text) });
        const patch = object.applyPatch();
        await began;
        current = false;
        const closer = Object.create(FileDom.prototype);
        Object.assign(closer, { shouldApply: () => true, windowCssFilePath: css, writeWithPermission: object.writeWithPermission });
        const closing = closer.clearBackground();
        const cancelled = assert.rejects(patch, /cancelled/);
        releaseCopy();
        await cancelled;
        assert.equal(await closing, true);
        const cleared = !fs.readFileSync(css, 'utf8').includes('STALE_B_BACKGROUND');
        const resurrected = fs.readFileSync(css, 'utf8') === 'STALE_B_BACKGROUND';
        assert.ok(cleared && !resurrected);
        return { cleared, resurrected };
    });
    await probe('appearance refresh preserves and follows the pending user selection', async () => {
        let current = 'A.png', resolveB, heldB = false;
        const installs = [];
        const cfg = { imagePath: '', opacity: 0.4, blur: 0, sizeModel: 'cover',
            get(key, fallback) { return this[key] ?? fallback; } };
        const { PickList } = load('out/PickList.js', {
            vscode: { window: { setStatusBarMessage: () => ({ dispose() {} }), showErrorMessage: async () => {} }, ConfigurationTarget: { Global: 1 } },
            './FileDom': { FileDom: class {
                constructor(_cfg, image) { this.image = image; this.requiresReload = false; }
                async install() { installs.push(this.image); if (this.image === 'B.pkg' && !heldB) { heldB = true; return new Promise(resolve => resolveB = resolve); } return true; }
            } },
            './global': {}, './windowBackground': { getWorkspaceKey: () => 'audit', getPinnedImagePath: () => '',
                resolveCurrentImagePath: () => current, resolveCurrentOpacity: v => v, resolveCurrentBlur: v => v,
                setCurrentImagePath: async (file, options) => { if (options.shouldPersist()) current = file; } },
            './settingsStore': { getAppConfig: () => cfg }, './sourceMode': {}, './vsHelp': {}
        }, { setTimeout: () => 0 });
        const pending = PickList.applyBackgroundPath('B.pkg');
        PickList.needAutoUpdate(cfg);
        const deadline = Date.now() + 5000;
        while (!resolveB) {
            assert.ok(Date.now() < deadline, 'pending selection must enter installation');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        resolveB(true);
        const applied = await pending;
        assert.equal(applied, true); assert.equal(current, 'B.pkg');
        assert.ok(!installs.includes('A.png'));
        const remote = await require('../out/displayRequests').claimDisplayRequest('audit', 'remote.pkg', new AbortController().signal);
        const count = installs.length;
        PickList.needAutoUpdate(cfg);
        assert.equal(await PickList.applyCurrentAppearance(cfg), true);
        assert.equal(installs.length, count, 'appearance must not overwrite another host\'s pending selection');
        await remote.finish();
        PickList.resumeDeferredAppearance();
        assert.equal(installs.at(-1), 'B.pkg', 'deferred appearance resumes against the successful current image');
        return { installs, userSelectionApplied: applied, persistedCurrent: current };
    });
    await probe('corrupt shared library keeps a recoverable restricted context', async () => {
        const file = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'library.json');
        fs.writeFileSync(file, '{broken');
        const shared = load('out/sharedLibrary.js', { vscode: { EventEmitter: Emitter } });
        const context = await shared.createSharedLibraryContext({ subscriptions: [], globalState: { get: () => undefined } });
        assert.ok(shared.getLibraryError());
        assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
        await shared.resetSharedLibrary();
        assert.equal(shared.getLibraryError(), '');
        const backups = fs.readdirSync(path.join(path.dirname(file), 'backups'));
        assert.ok(backups.some(name => fs.readFileSync(path.join(path.dirname(file), 'backups', name), 'utf8') === '{broken'));
        context.subscriptions.forEach(subscription => subscription.dispose());
        return { restrictedContextCreated: true, recoveredWithBackup: true };
    });
    await probe('reset clears scene caches and reports settings failure', async () => {
        const scene = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'scene-assets', 'wallpaper-scene-' + 'a'.repeat(64) + '.pkg');
        const preview = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'scene-preview', 'wallpaper-studio-scene.html');
        fs.mkdirSync(path.dirname(scene), { recursive: true }); fs.writeFileSync(scene, 'cached');
        fs.mkdirSync(path.dirname(preview), { recursive: true }); fs.writeFileSync(preview, 'cached page');
        let fired = false;
        const { StudioViewProvider } = load('out/StudioViewProvider.js', {
            vscode: { commands: { executeCommand: async () => {} } }, './PickList': { PickList: { stopAutoRandomTask() {}, applyBackgroundPath: async () => true } },
            './global': { onDidChangeGlobalState: { fire: () => fired = true } }, './sharedLibrary': { resetSharedLibrary: async () => {} },
            './sourceMode': { LOCAL_FILES_KEY: 'wallpaperStudioLocalFiles', DEFAULT_SOURCE_MODE: 'wallpaper' },
            './runtimeStore': { clearRuntimeState: async () => true },
            './windowBackground': { ensureWorkspaceRecord: async () => {} }, './thumbnailStore': {}, './scenePreview': {},
            './settingsStore': { getAppConfig: () => ({ update: async () => {} }), resetSettings: async () => { throw Error('disk denied'); } }
        });
        const provider = Object.create(StudioViewProvider.prototype);
        Object.assign(provider, { wallpaperSyncGeneration: 0, pendingThumbnails: new Map(), ctx: { globalState: { update: async () => {} } },
            thumbnails: { clear() {} }, pushState() {} });
        await assert.rejects(provider.resetAllState(), /disk denied/);
        assert.ok(!fired && !fs.existsSync(scene) && !fs.existsSync(preview));
        return { resetFailureReported: true, scenesRemain: fs.existsSync(scene), previewRemains: fs.existsSync(preview) };
    });
    await probe('preview memory ignores bounded thumbnail cache', async () => {
        const ts = require(path.join(root, 'node_modules/typescript'));
        const source = fs.readFileSync(path.join(root, 'webview/src/composables/useScenePreview.ts'), 'utf8');
        const js = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
        }).outputText;
        const thumbSource = ts.transpileModule(fs.readFileSync(path.join(root, 'webview/src/composables/useThumbnailCache.ts'), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
        }).outputText;
        const thumbnails = load('webview/src/composables/useThumbnailCache.ts', { vue: { ref: value => ({ value }) } }, {}, thumbSource);
        const previews = load('webview/src/composables/useScenePreview.ts', {
            vue: { reactive: value => value }, './useBridge': { useBridge: () => ({ on() {} }) },
            './useThumbnailCache': thumbnails
        }, {}, js);
        for (let i = 0; i < 1000; i++) {
            thumbnails.setThumbnail('scene:scene-' + i, 'data:image/jpeg;base64,' + 'A'.repeat(100));
            previews.useScenePreview().previewOf('scene-' + i);
        }
        assert.equal(previews.useScenePreview().previewOf('scene-0'), '', 'eviction must release every view of the same frame');
        assert.ok(previews.useScenePreview().previewOf('scene-999'));
        return { scenesVisited: 1000, oldestFrameEvictedFromAllViews: true };
    });
    await probe('fresh defaults produce a visible wallpaper layer', async () => {
        const defaults = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } }).DEFAULT_SETTINGS;
        const { FileDom } = load('out/FileDom.js', {
            vscode: { env: { appRoot: path.join(scratch, 'opacity-app'), uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 } },
            './global': {}, './windowBackground': {}, './SudoPromptHelper': {}
        });
        const object = Object.create(FileDom.prototype);
        Object.assign(object, { imageOpacity: defaults.opacity, sizeModel: 'cover', imagePath: 'sample.png',
            blur: 0, blendModel: 'auto', getViewPosition: () => 'center' });
        const css = object.getMediaCss();
        assert.ok(defaults.opacity > 0);
        assert.match(css, new RegExp('opacity:' + defaults.opacity + ';'));
        return { defaultOpacity: defaults.opacity, visibleByDefault: true };
    });
    await probe('closed transfer cancels its reader', async () => {
        const { WebSocket } = require(path.join(root, 'node_modules/ws'));
        const service = require(path.join(root, 'out/sceneTransport'));
        let release, entered, completed = false, cancellationObserved = false;
        const began = new Promise(resolve => entered = resolve);
        const url = await service.registerWallpaperAsset('audit-cancel', async signal => {
            entered(); await new Promise((resolve, reject) => {
                release = resolve;
                signal.addEventListener('abort', () => { cancellationObserved = true; reject(Error('cancelled')); }, { once: true });
            }); completed = true; return Buffer.from('unused');
        });
        const socket = new WebSocket(url);
        socket.on('error', () => undefined);
        await Promise.all([once(socket, 'open'), began]);
        socket.close(); await once(socket, 'close');
        for (let attempt = 0; !cancellationObserved && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        release(); await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(completed, false);
        assert.equal(cancellationObserved, true);
        service.disposeSceneTransport();
        return { readerCompletedAfterClientCancellation: completed, cancellationObserved };
    });
    console.log(JSON.stringify({ scratch, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    require(path.join(root, 'out/sceneTransport')).disposeSceneTransport();
});

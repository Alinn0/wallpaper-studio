'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { createRequire } = require('module');
const root = process.env.WALLPAPER_STUDIO_DATA_DIR;
function load(file, stubs = {}, globals = {}, source) {
    const filename = path.resolve(file), native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(source || fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
        process, Buffer, console, setTimeout, clearTimeout, ...globals
    }, { filename });
    return module.exports;
}
async function main() {
    const external = name => path.join(root, '..', 'wallpaper-lifecycle-' + name);
    const current = path.join(external('current'), 'a.pkg'), local = path.join(external('local'), 'b.mp4');
    const folder = external('folder'), playlist = external('playlist');
    const cfg = { get: (key, fallback) => key === 'randomImageFolder' ? folder : fallback };
    const { StudioViewProvider } = load('out/StudioViewProvider.js', {
        vscode: { Uri: { file: file => ({ fsPath: file }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) }, workspace: { workspaceFolders: [] } },
        './PickList': {}, './global': {}, './sharedLibrary': {}, './runtimeStore': {}, './scenePreview': {},
        './sourceMode': { getLocalFiles: () => [local], normalizeSourceMode: value => value },
        './settingsStore': { getAppConfig: () => cfg },
        './wallpaperEngine': { readWallpaperResourceDirectories: () => [playlist], WALLPAPER_USER_KEY: 'user' },
        './windowBackground': { resolveCurrentImagePath: () => current }
    });
    const provider = Object.create(StudioViewProvider.prototype);
    let optionsUpdates = 0;
    const webview = { cspSource: 'fixture-resource:' }; Object.defineProperty(webview, 'options', { set: () => optionsUpdates++ });
    Object.assign(provider, { ctx: { extensionUri: { fsPath: root }, globalState: { get: (_key, fallback) => fallback } },
        allowedRoots: new Set(), view: { webview }, sourceMode: 'wallpaper', rootsUpdatePending: false });
    provider.seedAllowedRoots();
    for (const file of [current, local, path.join(folder, 'sub/c.png'), path.join(playlist, 'preview.jpg'), path.join(root, 'scene-preview/wallpaper-studio-scene.html')]) {
        provider.ensureRootForFile(file);
    }
    await Promise.resolve();
    assert.equal(optionsUpdates, 0, 'current, list and preview runtime must already be covered before HTML loads');
    provider.ensureRootForFile(path.join(external('new-import-a'), 'a.png'));
    provider.ensureRootForFile(path.join(external('new-import-b'), 'b.mp4'));
    await Promise.resolve();
    assert.equal(optionsUpdates, 1, 'explicit new imports require at most one batched permission update');

    fs.mkdirSync(path.join(root, 'webview-dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'webview-dist/index.html'), '<html><head></head><body></body></html>');
    provider.ctx.extensionPath = root;
    const html = provider.getHtml(webview);
    assert.ok(html.includes('name="wallpaper-studio-source-mode" content="wallpaper"'));
    const source = fs.readFileSync('webview/src/composables/useStore.ts', 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    for (const mode of ['file', 'folder', 'wallpaper']) {
        const store = load('webview/src/composables/useStore.ts', { vue: { reactive: value => value }, './useBridge': { useBridge: () => ({ getState: () => ({}), patchState() {} }) } }, {
            document: { querySelector: () => ({ getAttribute: () => mode }) }
        }, compiled);
        assert.equal(store.state.sourceMode, mode, 'initial action buttons must use host mode before the first state reply');
    }
    for (const sameSession of [true, false]) {
        const store = load('webview/src/composables/useStore.ts', {
            vue: { reactive: value => value }, './useBridge': { useBridge: () => ({ getState: () => ({ sourceSnapshot: { session: sameSession ? 'current' : 'old', mode: 'folder' } }), patchState() {} }) }
        }, { document: { querySelector: selector => ({ getAttribute: () => selector.includes('view-session') ? 'current' : 'wallpaper' }) } }, compiled);
        assert.equal(store.state.sourceMode, sameSession ? 'folder' : 'wallpaper', 'permissions reload preserves mode; a new host session uses current shared mode');
    }
    let syncs = 0;
    provider.wallpaperSyncPromise = Promise.resolve(); provider.wallpaperUser = 'discovered'; provider.galleryRequested = true;
    provider.ctx.globalState.get = (key, fallback) => key === 'wallpaperStudioSourceMode' ? 'wallpaper' : key === 'user' ? 'discovered' : fallback;
    provider.syncWallpaperPlaylist = async () => syncs++;
    provider.pushState = () => {};
    await provider.refreshSharedLibrary(['user']);
    assert.equal(syncs, 0, 'remembering a discovered user must not restart the same active playlist read');
    let savedMode = 'wallpaper', oldCurrent = true;
    const commits = [];
    const modes = load('out/sourceMode.js', {
        './global': { getContext: () => ({ globalState: { get: () => savedMode,
            mutate: (_key, _fallback, change) => new Promise(resolve => commits.push(() => { savedMode = change(savedMode); resolve(); })) } }) },
        './settingsStore': {}, './wallpaperEngine': {}, './pathUtil': {}
    });
    const older = modes.setSourceMode('file', () => oldCurrent); oldCurrent = false;
    const newest = modes.setSourceMode('folder');
    commits[1](); await newest; commits[0](); await older;
    assert.equal(savedMode, 'folder', 'an old request acquiring the persistence lock last must not overwrite the latest mode');
    console.log('PASS initial resources cover home/list/runtime, imports batch, source mode boots consistently and user discovery never restarts active reads');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

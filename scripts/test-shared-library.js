'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
function load(file, stubs = {}) {
    const filename = path.resolve(file), native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
        process, Buffer, console, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
}
class Emitter {
    constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(keys) { this.listeners.forEach(fn => fn(keys)); }
}
function profile(values = {}) {
    const data = new Map(Object.entries(values));
    return { subscriptions: [], globalState: {
        get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
        keys: () => [...data.keys()],
        update: async (key, value) => value === undefined ? data.delete(key) : data.set(key, value)
    } };
}
const FILES = 'wallpaperStudioLocalFiles', PROPS = 'wallpaperStudioWallpaperProperties';
const filename = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'library.json');
const engine = require('../out/wallpaperEngine');
const { mutateState } = require('../out/stateMutation');
const contexts = [];
async function main() {
    const A = load('out/sharedLibrary.js', { vscode: { EventEmitter: Emitter } });
    const B = load('out/sharedLibrary.js', { vscode: { EventEmitter: Emitter } });
    const rawA = profile({ [FILES]: ['a.png'], wallpaperStudioSourceMode: 'file', wallpaperStudioLocale: 'zh',
        [PROPS]: { [path.normalize('C:/walls/a.png').toLowerCase()]: { cameraPanX: 12 } } });
    // Real VS Code contexts expose a frozen globalState; plain mock objects hid the activation crash.
    Object.defineProperty(rawA, 'globalState', { value: rawA.globalState, writable: false, configurable: false });
    rawA.asAbsolutePath = function(relative) { assert.equal(this, rawA); return '/extension/' + relative; };
    const a = await A.createSharedLibraryContext(rawA); contexts.push(a);
    assert.equal(a.asAbsolutePath('resources'), '/extension/resources');
    assert.equal(a.subscriptions, rawA.subscriptions);
    const b = await B.createSharedLibraryContext(profile({ [FILES]: ['stale.png'], wallpaperStudioSourceMode: 'folder',
        wallpaperStudioLocale: 'en' })); contexts.push(b);
    assert.deepEqual([...b.globalState.get(FILES)], ['a.png']);
    assert.equal(b.globalState.get('wallpaperStudioSourceMode'), 'file');
    assert.equal(b.globalState.get('wallpaperStudioLocale'), 'en');
    assert.equal(a.globalState.get('wallpaperStudioLocale'), 'zh');
    console.log('PASS initial profile migrates; later profiles read shared values and retain private language');
    await Promise.all([
        mutateState(a.globalState, FILES, [], entries => [...entries, 'b.png']),
        mutateState(b.globalState, FILES, [], entries => [...entries, 'c.png'])
    ]);
    assert.deepEqual([...a.globalState.get(FILES)].sort(), ['a.png', 'b.png', 'c.png']);
    await Promise.all([
        engine.setWallpaperProperty(a.globalState, 'C:/walls/a.png', 'cameraPanY', 25),
        engine.setWallpaperProperty(b.globalState, 'C:\\walls\\a.png', 'speed', 2)
    ]);
    const props = engine.getWallpaperPropertyOverrides(b.globalState, 'C:/walls/a.png');
    assert.equal(props.cameraPanX, 12); assert.equal(props.cameraPanY, 25); assert.equal(props.speed, 2);
    console.log('PASS concurrent additions and edits to one wallpaper preserve both writers and view offsets');
    const changed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('library watcher timed out')), 5000);
        const stop = B.onDidChangeLibrary(keys => {
            if (keys.includes('wallpaperStudioWallpaperConfig')) { clearTimeout(timeout); stop.dispose(); resolve(); }
        });
    });
    await a.globalState.update('wallpaperStudioWallpaperConfig', 'D:/shared/config.json');
    await changed;
    assert.equal(b.globalState.get('wallpaperStudioWallpaperConfig'), 'D:/shared/config.json');
    await mutateState(a.globalState, FILES, [], entries => entries.filter(entry => entry !== 'a.png'));
    const c = await A.createSharedLibraryContext(rawA); contexts.push(c);
    assert.ok(!c.globalState.get(FILES).includes('a.png'));
    console.log('PASS another module receives file notifications; restarting old profile never resurrects removals');
    const broken = load('out/sharedLibrary.js', {
        vscode: { EventEmitter: Emitter },
        './atomicWrite': { atomicWriteTextSync() { throw Error('disk full'); } }
    });
    const failing = await broken.createSharedLibraryContext(profile()); contexts.push(failing);
    const before = fs.readFileSync(filename, 'utf8');
    await assert.rejects(failing.globalState.update(FILES, []), /disk full/);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    fs.writeFileSync(filename, '{invalid');
    await assert.rejects(a.globalState.update(FILES, []));
    assert.equal(fs.readFileSync(filename, 'utf8'), '{invalid');
    fs.writeFileSync(filename, before);
    console.log('PASS failed writes preserve data and invalid JSON is never overwritten');
    let reads = 0;
    const cached = load('out/sharedLibrary.js', { vscode: { EventEmitter: Emitter },
        fs: { ...fs, readFileSync(file, ...args) { if (file === filename) reads++; return fs.readFileSync(file, ...args); } } });
    const cacheContext = await cached.createSharedLibraryContext(profile()); contexts.push(cacheContext);
    for (let i = 0; i < 100; i++) { engine.getWallpaperPropertyOverrides(cacheContext.globalState, 'C:/walls/a.png'); }
    assert.equal(reads, 1);
    console.log('PASS repeated property reads reuse parsed library instead of rereading the file');
    const providerModule = load('out/StudioViewProvider.js', {
        vscode: {}, './sharedLibrary': {}, './PickList': {}, './global': {}, './thumbnailStore': {},
        './sourceMode': { normalizeSourceMode: value => value || 'wallpaper' },
        './scenePreview': {}, './runtimeStore': {},
        './windowBackground': { resolveCurrentImagePath: () => 'current.png' },
        './settingsStore': { getAppConfig: () => ({ get: () => '' }) }
    });
    const view = Object.create(providerModule.StudioViewProvider.prototype), calls = [];
    Object.assign(view, { ctx: b, galleryRequested: true,
        pushState: full => calls.push(['push', full]), syncWallpaperPlaylist: async () => calls.push(['playlist']),
        scheduleWallpaperPropertyApply: file => calls.push(['property', file]) });
    await view.refreshSharedLibrary([PROPS]);
    assert.equal(view.sourceMode, 'file');
    assert.deepEqual(calls, [['property', 'current.png'], ['push', false]]);
    await a.globalState.update('wallpaperStudioSourceMode', 'wallpaper');
    await view.refreshSharedLibrary(['wallpaperStudioSourceMode']);
    assert.equal(view.sourceMode, 'wallpaper');
    assert.equal(view.wallpaperConfigPath, 'D:/shared/config.json');
    assert.ok(calls.some(call => call[0] === 'playlist'));
    console.log('PASS remote property updates reach active wallpaper without open panel; source changes refresh gallery');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    contexts.forEach(context => context.subscriptions.forEach(subscription => subscription.dispose()));
});

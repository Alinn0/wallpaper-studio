'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { createRequire } = require('module');
const { ThumbnailStore } = require('../out/thumbnailStore');
function load(file, stubs = {}, source, globals = {}) {
    const filename = path.resolve(file), native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(source || fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
        process, Buffer, console, setTimeout, clearTimeout, AbortController, ...globals
    }, { filename });
    return module.exports;
}
function browserCache() {
    const file = 'webview/src/composables/useThumbnailCache.ts';
    return load(file, { vue: { ref: value => ({ value }) } }, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText);
}
async function main() {
    const directory = process.env.WALLPAPER_STUDIO_DATA_DIR;
    const store = new ThumbnailStore(directory), writes = [];
    const first = browserCache();
    first.setThumbnailReader(keys => store.snapshot(keys));
    first.setThumbnailReporter((key, value) => writes.push(store.set(key, value)));
    const uri = 'https://file+.vscode-resource.vscode-cdn.net/e:/fixture/scene.pkg?v=1-99-1';
    const keys = ['image:image.png?v=1', 'video:video.mp4?v=1', 'scene:' + uri];
    await first.ensureThumbnails(keys);
    assert.equal(first.thumbnailCacheStats.diskMisses, 3);
    keys.forEach((key, i) => first.setThumbnail(key, 'data:image/jpeg;base64,' + Buffer.from('frame' + i).toString('base64')));
    await Promise.all(writes);
    assert.equal(Object.keys(await new ThumbnailStore(directory).snapshot()).length, 3, 'first generated previews really reach disk');

    const reopened = browserCache(), disk = new ThumbnailStore(directory);
    let release, reads = 0;
    const gate = new Promise(resolve => release = resolve);
    reopened.setThumbnailReader(async selected => { reads++; await gate; return disk.snapshot(selected); });
    const checking = reopened.ensureThumbnails(keys);
    const same = reopened.ensureThumbnails(keys);
    await Promise.resolve();
    assert.equal(reopened.isThumbnailReady(keys[0]), false, 'original image must not start while disk lookup is pending');
    assert.equal(reopened.isThumbnailReady(keys[1]), false, 'original video must not start while disk lookup is pending');
    release(); await Promise.all([checking, same]);
    assert.equal(reads, 1, 'home and list coalesce the same reads');
    assert.equal(reopened.thumbnailCacheStats.diskHits, 3);
    assert.equal(reopened.thumbnailCacheStats.generated, 0);
    keys.forEach(key => assert.ok(reopened.getThumbnail(key)));
    await reopened.ensureThumbnails(keys); assert.equal(reads, 1, 'second visit serves from memory');
    const previewFile = 'webview/src/composables/useScenePreview.ts';
    let sceneFetches = 0;
    const scenes = load(previewFile, { vue: { reactive: value => value }, './useBridge': { useBridge: () => ({}) }, './useThumbnailCache': reopened },
        ts.transpileModule(fs.readFileSync(previewFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
        { fetch() { sceneFetches++; throw Error('cached scene must never fetch its package'); } });
    assert.ok(await scenes.useScenePreview().requestPreview(uri));
    assert.equal(sceneFetches, 0); assert.equal(reopened.thumbnailCacheStats.sceneRenders, 0);
    await reopened.ensureThumbnails(['image:image.png?v=2']);
    assert.equal(reopened.getThumbnail('image:image.png?v=2'), '');
    assert.equal(reopened.isThumbnailReady('image:image.png?v=2'), true, 'changed source may generate only after confirmed miss');
    const observer = new ThumbnailStore(directory); observer.warm();
    await store.set('image:another-window.png', 'data:image/jpeg;base64,YQ==');
    assert.ok((await observer.snapshot(['image:another-window.png']))['image:another-window.png'], 'prewarmed index must see another host\'s cache additions');
    const reset = browserCache();
    let releaseOld;
    reset.setThumbnailReader(() => new Promise(resolve => releaseOld = resolve));
    const oldRead = reset.ensureThumbnails(['image:before-reset']); await Promise.resolve();
    reset.clearThumbnailCache(); releaseOld({ 'image:before-reset': 'data:image/jpeg;base64,YQ==' }); await oldRead;
    assert.equal(reset.getThumbnail('image:before-reset'), '', 'late disk response must not restore purged cache');
    const bounded = browserCache(); bounded.setCurrentPreviewKeys(['image:home']);
    bounded.setThumbnail('image:home', 'data:image/jpeg;base64,' + 'A'.repeat(300000));
    for (let i = 0; i < 30; i++) bounded.setThumbnail('image:list-' + i, 'data:image/jpeg;base64,' + 'B'.repeat(600000));
    assert.ok(bounded.getThumbnail('image:home'), 'loading a large gallery must not evict the displayed home preview');
    assert.equal(bounded.getThumbnail('image:list-0'), '', 'pinning home must still enforce the shared cache budget');
    bounded.setCurrentPreviewKeys([]);
    for (let i = 0; i < 350; i++) bounded.setThumbnail('image:next-' + i, 'data:image/jpeg;base64,' + 'C'.repeat(100));
    assert.ok(!bounded.getThumbnail('image:home'), 'unmounted home releases its protected cache entry');
    console.log('PASS first frames persist; fresh panel waits for targeted disk hits; repeat image/video/scene uses cache without regeneration');

    // Exercise the actual gallery handlers: cache misses mount videos before layout,
    // including while the persistent gallery tab is hidden behind Home.
    const galleryFile = 'webview/src/views/LocalGalleryTab.vue';
    const gallerySource = fs.readFileSync(galleryFile, 'utf8');
    const script = gallerySource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
    const videoWrites = [], observedVideos = [];
    let intersect;
    const gallery = load(galleryFile, {
        vue: { computed: fn => ({ get value() { return fn(); } }), reactive: v => v, ref: v => ({ value: v }),
            watch() {}, onMounted() {}, onUpdated() {}, onUnmounted() {}, nextTick: fn => Promise.resolve().then(fn) },
        '@element-plus/icons-vue': {},
        '../composables/useI18n': { useI18n: () => ({ t: key => key === 'wallpaperPlaylistLoading' ? '已加载 {loaded}/{total}' : key }) },
        '../composables/useBridge': { useBridge: () => ({}) },
        '../composables/useScenePreview': { useScenePreview: () => ({}) },
        '../composables/useStore': { config: {}, state: { sourceMode: 'wallpaper', wallpaperLoading: true, wallpaperLoaded: 7, wallpaperTotal: 12 } },
        '../constants': { ActionType: {} }, '../utils/media': { isVideoPath: key => key.includes('.mp4'), isWallpaperPkgPath: () => false },
        '../composables/useThumbnailCache': { thumbnailView: () => ({}), setThumbnail: (...args) => videoWrites.push(args) },
        '../composables/useProjectCover': { getProjectCover: () => '', projectCoverKey: source => 'project-cover:' + source },
        '../../../src/mediaTypes': {}
    }, ts.transpileModule(script + '\nexport { registerVideoThumb, captureVideoFrame, displayLoadingDescription };', {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText, {
        IntersectionObserver: class { constructor(callback) { intersect = callback; } observe(node) { observedVideos.push(node); } unobserve() {} },
        HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
        document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,dmlkZW8=' }) }
    });
    let loads = 0, pauses = 0;
    const video = { dataset: { video: 'unselected.mp4?v=1' }, getClientRects: () => [], closest: () => null,
        load() { loads++; }, pause() { pauses++; }, play() { throw Error('thumbnail must not require playback'); },
        videoWidth: 1920, videoHeight: 1080, readyState: 1 };
    gallery.registerVideoThumb(video);
    assert.equal(observedVideos[0], video, 'unselected video is observed even before layout or while tab is hidden');
    assert.equal(loads, 0, 'offscreen videos remain lazy');
    intersect([{ target: video, isIntersecting: true }]);
    assert.equal(loads, 1, 'becoming visible loads an unselected video without selecting its wallpaper');
    gallery.registerVideoThumb(video); assert.equal(loads, 1, 'rerenders do not reload the video');
    gallery.captureVideoFrame({ currentTarget: video }, video.dataset.video);
    assert.equal(videoWrites.length, 0, 'metadata alone is not a decoded frame');
    video.readyState = 2;
    gallery.captureVideoFrame({ currentTarget: video }, video.dataset.video);
    assert.equal(videoWrites[0][0], 'video:unselected.mp4?v=1', 'unselected video frame enters the shared persistent cache');
    assert.equal(pauses, 1);
    assert.equal(gallery.displayLoadingDescription.value, '已加载 7/12');
    assert.ok(gallerySource.includes('class="playlist-progress" role="status">{{ displayLoadingDescription }}'), 'live progress is visible outside flex rows');
    assert.match(gallerySource, /watch\(visibleWallpapers, \(\) => \{[\s\S]*?hydrateVideoThumbnails\(\);[\s\S]*?scenePreview.cancelQueuedExcept/, 'async playlist arrivals must query media cache without relying on parent onUpdated (el-card slots update separately)');
    console.log('PASS unselected video loads after hidden/pre-layout mount, caches its decoded frame, and playlist progress is visible');

    let finishOld, releaseSwitch;
    const selected = [], stored = { mode: 'file' };
    const { StudioViewProvider } = load('out/StudioViewProvider.js', {
        vscode: { commands: { executeCommand: async () => {} } }, './global': {},
        './sharedLibrary': {}, './windowBackground': {}, './runtimeStore': {}, './scenePreview': {},
        './PickList': { PickList: { applyBackgroundPath: async (value, options) => { if (options.isCurrent()) selected.push(value); return true; } } },
        './sourceMode': { normalizeSourceMode: value => value, setSourceMode: async value => { stored.mode = value; } },
        './settingsStore': {}, './wallpaperEngine': {}
    });
    const provider = Object.create(StudioViewProvider.prototype);
    Object.assign(provider, { sourceMode: 'file', sourceModeGeneration: 0, pushState() {}, notifyWallpaperNotice() {},
        getModeCandidates: mode => [mode + '.png'], syncWallpaperPlaylist: () => new Promise(resolve => { finishOld = resolve; releaseSwitch?.(); }) });
    const started = new Promise(resolve => releaseSwitch = resolve);
    const old = provider.handleMessage({ type: 'setSourceMode', mode: 'wallpaper' }); await started;
    await provider.handleMessage({ type: 'setSourceMode', mode: 'folder' });
    await provider.handleMessage({ type: 'setSourceMode', mode: 'file' });
    finishOld(); await old;
    assert.equal(provider.sourceMode, 'file'); assert.equal(stored.mode, 'file');
    assert.deepEqual(selected, ['folder.png', 'file.png'], 'late Wallpaper result must not select an old mode or close its background');
    console.log('PASS delayed Wallpaper switch cannot overwrite later folder/file selections');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

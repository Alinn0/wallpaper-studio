'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(source, dependencies, globals = {}) {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
        { module, exports: module.exports, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; },
            console, setTimeout, clearTimeout, AbortController, ...globals });
    return module.exports;
}
const vue = { ref: value => ({ value }), reactive: value => value, computed: fn => ({ get value() { return fn(); } }),
    watch() {}, onMounted() {}, onUpdated() {}, onUnmounted() {}, nextTick: fn => Promise.resolve().then(fn) };
const cacheSource = fs.readFileSync('webview/src/composables/useThumbnailCache.ts', 'utf8');
const coverSource = fs.readFileSync('webview/src/composables/useProjectCover.ts', 'utf8');
async function main() {
    const cache = load(cacheSource, { vue });
    const disk = new Map(), images = [], sizes = [], timers = new Set();
    cache.setThumbnailReader(async keys => Object.fromEntries(keys.filter(k => disk.has(k)).map(k => [k, disk.get(k)])));
    cache.setThumbnailReporter((key, value) => disk.set(key, value));
    class Image {
        constructor() { images.push(this); this.naturalWidth = 1920; this.naturalHeight = 1080; }
        removeAttribute() { this.removed = true; }
    }
    const browser = { Image, document: { createElement: () => {
        const canvas = { getContext: () => ({ drawImage: () => sizes.push([canvas.width, canvas.height]) }), toDataURL: () => 'data:image/jpeg;base64,Y292ZXI=' };
        return canvas;
    } }, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) };
    const covers = load(coverSource, { vue, './useThumbnailCache': cache }, browser);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const jobs = controllers.map((c, i) => covers.requestProjectCover(`cover-${i}.jpg?v=1`, c.signal));
    await tick(); assert.equal(images.length, 3, 'at most three cover reads run concurrently');
    controllers[4].abort(); assert.equal(await jobs[4], '', 'offscreen queued job cancels without decoding');
    images[0].onload(); await jobs[0]; await tick();
    assert.equal(images.length, 4, 'finishing one job admits the next visible cover');
    images[1].onerror(); assert.equal(await jobs[1], '', 'decode failure enables fallback');
    controllers[2].abort(); assert.equal(await jobs[2], '', 'inflight work cancels on mode change');
    assert.equal(images[2].removed, true);
    images[3].onload(); await jobs[3];
    assert.deepEqual(sizes[0], [320, 180], 'artwork is resized before persisting');
    assert.ok(disk.has('project-cover:cover-0.jpg?v=1'));
    assert.equal([...disk.keys()].some(k => /^(scene|video|image):/.test(k)), false, 'covers cannot overwrite original preview caches');
    const count = images.length;
    await covers.requestProjectCover('cover-0.jpg?v=1', new AbortController().signal);
    assert.equal(images.length, count, 'memory hit does not decode again');
    const freshCache = load(cacheSource, { vue });
    freshCache.setThumbnailReader(async keys => Object.fromEntries(keys.filter(k => disk.has(k)).map(k => [k, disk.get(k)])));
    const reopened = load(coverSource, { vue, './useThumbnailCache': freshCache }, browser);
    assert.ok(await reopened.requestProjectCover('cover-0.jpg?v=1', new AbortController().signal));
    assert.equal(images.length, count, 'reopened panel uses disk thumbnail without reading original cover');
    const changed = reopened.requestProjectCover('cover-0.jpg?v=2', new AbortController().signal);
    await tick(); assert.equal(images.length, count + 1, 'file signature change invalidates artwork');
    for (const timeout of [...timers]) timeout();
    assert.equal(await changed, '', 'timeout releases queue and enables fallback');
    assert.equal(timers.size, 0);

    const gif = 'preview.GIF?v=2';
    disk.set(covers.projectCoverKey(gif), 'data:image/jpeg;base64,d2hpdGU=');
    const canvasCount = sizes.length;
    const gifRequest = covers.requestProjectCover(gif, new AbortController().signal);
    await tick();
    assert.equal(images.at(-1).src, gif, 'GIF bypasses old white JPEG cache');
    images.at(-1).onload();
    assert.equal(await gifRequest, gif, 'preserve original animated GIF URL');
    assert.equal(sizes.length, canvasCount, 'GIF never freezes on the first frame via canvas');
    assert.equal(covers.getProjectCover(gif), gif);
    assert.equal(await covers.requestProjectCover(gif, new AbortController().signal), gif, 'list and home reuse validated animation');

    const state = { sourceMode: 'wallpaper', wallpaperLoadedOnce: true, wallpaperPlaylist: [
        { path: 'scene.pkg', sceneSource: 'scene.pkg?v=1', mediaSource: 'scene.pkg?v=1', preview: 'art.jpg?v=1', title: 'Scene', active: true },
        { path: 'video.mp4', mediaSource: 'video.mp4?v=1', preview: 'video.jpg?v=1', title: 'Video', active: true },
        { path: 'image.png', mediaSource: 'image.png?v=1', preview: 'image.jpg?v=1', title: 'Image', active: true }
    ], localFiles: [], folderImages: [] };
    let intersect, reads = 0, renders = 0;
    const lookup = [], observed = [], rows = [];
    const galleryText = fs.readFileSync('webview/src/views/LocalGalleryTab.vue', 'utf8');
    const script = galleryText.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
    const gallery = load(script + '\nexport { projectCoverSource, registerThumb, onPkgHover, hydrateVideoThumbnails };', {
        vue, '@element-plus/icons-vue': {}, '../composables/useI18n': { useI18n: () => ({ t: x => x }) },
        '../composables/useBridge': { useBridge: () => ({}) }, '../composables/useStore': { config: {}, state },
        '../composables/useScenePreview': { useScenePreview: () => ({ previewOf: () => '', requestPreview: async () => { renders++; return 'frame'; } }) },
        '../constants': {}, '../../../src/mediaTypes': {},
        '../utils/media': { isVideoPath: s => s.includes('.mp4'), isWallpaperPkgPath: s => s.includes('.pkg') },
        '../composables/useThumbnailCache': { thumbnailView: () => ({}), ensureThumbnails: keys => { lookup.push(...keys); return Promise.resolve(); }, getThumbnail: () => '' },
        '../composables/useProjectCover': { getProjectCover: () => '', projectCoverKey: covers.projectCoverKey, requestProjectCover: async () => { reads++; return ''; } }
    }, { IntersectionObserver: class { constructor(fn) { intersect = fn; } observe(node) { observed.push(node); } unobserve() {} },
        document: { querySelectorAll: () => rows } });
    for (const item of state.wallpaperPlaylist) assert.equal(gallery.projectCoverSource(item), item.preview, 'all Wallpaper media types prefer project artwork');
    gallery.hydrateVideoThumbnails(); assert.equal(lookup.length, 0, 'artwork pending does not request original thumbnails');
    gallery.onPkgHover('scene.pkg?v=1'); assert.equal(renders, 0, 'hover cannot start scene rendering while artwork is available');
    const row = { dataset: { cover: 'art.jpg?v=1', pkg: 'scene.pkg?v=1' }, getClientRects: () => [], closest: () => null };
    gallery.registerThumb(row); assert.equal(observed[0], row, 'hidden or pre-layout row is observed');
    assert.equal(reads, 0, 'offscreen artwork does not load');
    intersect([{ target: row, isIntersecting: false }]); assert.equal(reads, 0);
    intersect([{ target: row, isIntersecting: true }]); await tick();
    assert.equal(reads, 1); assert.equal(gallery.projectCoverSource(state.wallpaperPlaylist[0]), '', 'broken cover activates original path');
    assert.ok(lookup.includes('scene:scene.pkg?v=1'));
    gallery.onPkgHover('scene.pkg?v=1'); await tick(); assert.equal(renders, 1, 'scene fallback still renders its original frame');
    state.sourceMode = 'folder'; assert.equal(gallery.projectCoverSource({ preview: 'art.jpg' }), '');
    state.sourceMode = 'file'; assert.equal(gallery.projectCoverSource({ preview: 'art.jpg' }), '');
    assert.ok(galleryText.indexOf('<template v-if="projectCoverSource(wallpaper)">') < galleryText.indexOf('<video'), 'cover branch blocks original media elements');
    assert.match(galleryText, /:src="wallpaper.mediaSource \|\| wallpaper.preview"[^\n]*captureImageThumb/, 'broken image cover falls back to the original image');
    const homeConfig = { imagePath: 'scene.pkg', imagePathDisplay: 'scene.pkg?v=1', imageProjectPreview: gif, imageProperties: [] };
    state.sourceMode = 'wallpaper';
    let pendingCover, homeReads = 0, homeRenders = 0;
    const homeTimers = [];
    const homeSource = fs.readFileSync('webview/src/views/HomeTab.vue', 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
    const home = load(homeSource + '\nexport { scheduleCurrentPreview, previewThumbnail, useProjectCover };', {
        vue, '@element-plus/icons-vue': {}, '../composables/useI18n': { useI18n: () => ({ t: x => x }) },
        '../composables/useBridge': { useBridge: () => ({ post() {} }) },
        '../composables/useStore': { config: homeConfig, state },
        '../composables/useDisplayFps': { useDisplayFps: () => ({ refreshLimit: { value: 60 } }) },
        '../composables/useScenePreview': { useScenePreview: () => ({ cacheKeys: () => ['scene:frame'], cancelPriority() {}, previewOf: () => 'old-scene-frame', requestPreview: async () => { homeRenders++; } }) },
        '../../../src/mediaTypes': { mediaPathKey: x => x },
        '../utils/media': { isVideoPath: s => s.includes('.mp4'), isWallpaperPkgPath: s => s.includes('.pkg') },
        '../composables/useThumbnailCache': { getThumbnail: () => '', setCurrentPreviewKeys() {}, thumbnailRevision: { value: 0 }, ensureThumbnails: async () => { homeReads++; } },
        '../composables/useProjectCover': { getProjectCover: covers.getProjectCover, projectCoverKey: covers.projectCoverKey, requestProjectCover: (source, signal) => new Promise(resolve => { pendingCover = { source, signal, resolve }; }) }
    }, { document: { hidden: false }, setTimeout: fn => { homeTimers.push(fn); return fn; }, clearTimeout() {} });
    const firstHome = home.scheduleCurrentPreview();
    assert.equal(homeReads, 0, 'home does not read original media while cover loads');
    assert.equal(home.previewThumbnail.value, gif, 'home displays GIF instead of old scene frame');
    pendingCover.resolve(gif); await firstHome;
    assert.equal(homeRenders, 0, 'home artwork avoids scene rendering');
    homeConfig.imageProjectPreview = 'broken.jpg';
    const brokenHome = home.scheduleCurrentPreview(); pendingCover.resolve(''); await brokenHome;
    assert.equal(home.useProjectCover.value, false, 'home enables original fallback after cover failure');
    assert.equal(homeReads, 1); homeTimers.pop()(); await tick(); assert.equal(homeRenders, 1);
    homeConfig.imageProjectPreview = 'slow.gif';
    const oldHome = home.scheduleCurrentPreview(), oldCover = pendingCover;
    homeConfig.imageProjectPreview = gif;
    const newHome = home.scheduleCurrentPreview();
    assert.equal(oldCover.signal.aborted, true, 'changing wallpaper cancels old artwork');
    oldCover.resolve(''); pendingCover.resolve(gif); await Promise.all([oldHome, newHome]);
    assert.equal(home.previewThumbnail.value, gif, 'late old cover failure cannot replace new home artwork');
    state.sourceMode = 'file'; assert.equal(home.useProjectCover.value, false, 'file mode retains original previews');
    console.log('PASS GIF animation bypasses old white-frame cache; home prefers artwork, falls back and cancels stale requests');
    console.log('PASS project artwork: visibility, concurrency, abort, timeout, persistent reuse, signatures, original-preview isolation and fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

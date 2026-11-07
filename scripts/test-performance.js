'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const { createRequire } = require('module');
const ts = require('typescript');

function loadCjs(filename, stubs = {}, globals = {}, source) {
    filename = path.resolve(filename);
    const native = createRequire(filename), module = { exports: {} };
    const requireModule = name => Object.hasOwn(stubs, name) ? stubs[name] : native(name);
    requireModule.resolve = native.resolve;
    vm.runInNewContext(source || fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: requireModule,
        process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, ...globals
    }, { filename });
    return module.exports;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
    throw Error('condition timed out');
}
function fakeDocument(events = []) {
    const nodes = [];
    const canvas = { width: 1280, height: 720 };
    const host = { querySelector: () => canvas, style: {}, replaceChildren() { events.push('host-clear'); } };
    const document = {
        hidden: false, visibilityState: 'visible', addEventListener() {},
        getElementById: id => id === 'scene-host' ? host : nodes.find(node => node.id === id),
        body: { appendChild: node => { nodes.push(node); events.push('poster-added'); } },
        createElement: tag => ({ tag, style: {}, setAttribute() {},
            remove() { const index = nodes.indexOf(this); if (index >= 0) nodes.splice(index, 1); },
            getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,YQ==' })
    };
    return { document, nodes };
}

async function main() {
    {
        const { backgroundSourceMarker, matchesBackgroundSource, patchBackgroundAppearance } = require('../out/backgroundCache');
        const source = 'C:/wallpapers/a.pkg';
        const config = { url: 'cached.pkg', properties: { speed: 2 }, project: { file: 'scene.json' }, opacity: 0.2, blur: 0 };
        const css = backgroundSourceMarker(source) + '/*wallpaper-studio-scene-start*/' + JSON.stringify(config) + '/*wallpaper-studio-scene-end*/';
        assert.equal(matchesBackgroundSource(css, source), true);
        assert.equal(matchesBackgroundSource(css, 'C:/wallpapers/b.pkg'), false);
        assert.equal(patchBackgroundAppearance(css, 'C:/wallpapers/b.pkg', 0.5, 8), undefined);
        const next = patchBackgroundAppearance(css, source, 0.5, 8);
        const data = JSON.parse(next.match(/scene-start\*\/([\s\S]*?)\/\*wallpaper/)[1]);
        assert.equal(data.opacity, 0.5); assert.equal(data.blur, 8);
        assert.deepEqual(data.properties, config.properties); assert.deepEqual(data.project, config.project);
        const image = backgroundSourceMarker(source) + 'body::before{opacity:0.2;filter:blur(0px);background-image:url(a.png);}';
        const patchedImage = patchBackgroundAppearance(image, source, 0.4, 6);
        assert.match(patchedImage, /opacity:0.4/); assert.match(patchedImage, /filter:blur\(6px\)/);
        assert.match(patchedImage, /background-image:url\(a.png\)/);
        console.log('PASS verified source identity and appearance-only patch preserves scene and media');
    }
    {
        const root = process.env.WALLPAPER_STUDIO_DATA_DIR;
        const source = path.join(root, 'continuity.pkg'), assets = path.join(root, 'assets');
        fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(source, Buffer.alloc(4096, 4));
        let streams = 0;
        const measuredFs = { ...fs, createReadStream(...args) { streams++; return fs.createReadStream(...args); } };
        const cold = loadCjs('out/wallpaperScene.js', { fs: measuredFs });
        const target = await cold.copyWallpaperScenePackage(source, assets);
        assert.equal(streams, 1);
        const warm = loadCjs('out/wallpaperScene.js', { fs: measuredFs });
        assert.equal(await warm.copyWallpaperScenePackage(source, assets), target);
        assert.equal(streams, 1, 'new process module should reuse persisted source hash');
        const first = await warm.buildWallpaperScenePage(path.resolve('.'));
        const second = await warm.buildWallpaperScenePage(path.resolve('.'));
        assert.equal(first, second, 'HTML/base64 and patched runtime are reused');
        fs.writeFileSync(source, Buffer.alloc(8192, 7));
        assert.notEqual(await warm.copyWallpaperScenePackage(source, assets), target);
        assert.equal(streams, 2);
        console.log('PASS cold hash reads=1, warm hash reads=0; source changes invalidate; runtime HTML memoized');
    }
    {
        const { SCENE_CONTINUITY_JS } = require('../out/sceneContinuity');
        const records = new Map();
        const storage = { get length() { return records.size; }, key: i => [...records.keys()][i],
            getItem: key => records.get(key) || null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
        const { document, nodes } = fakeDocument();
        const target = { document, localStorage: storage };
        const box = {};
        vm.runInNewContext(SCENE_CONTINUITY_JS, box);
        const config = { url: 'scene-A.pkg', properties: { speed: 1 }, opacity: 0.2, blur: 0, blendMode: 'lighten' };
        const poster = 'data:image/jpeg;base64,YQ==';
        box.saveWallpaperPoster(target, 'workspace-A.css', config, poster);
        box.showWallpaperPoster(target, 'workspace-B.css', config);
        assert.equal(nodes.length, 0, 'another workspace must never show this poster');
        box.showWallpaperPoster(target, 'workspace-A.css', { ...config, properties: { speed: 2 } });
        assert.equal(nodes.length, 0, 'changed scene properties invalidate the cached frame');
        box.showWallpaperPoster(target, 'workspace-A.css?t=1', config);
        assert.equal(nodes.length, 1);
        box.clearWallpaperPoster(target);
        assert.equal(nodes.length, 0);
        for (let i = 0; i < 15; i++) box.saveWallpaperPoster(target, `workspace-${i}.css`, config, poster);
        assert.ok(records.size <= 8);
        for (let i = 0; i < 100; i++) box.recordWallpaperTiming(target, 'test', i);
        assert.equal(target.__wallpaperStudioPerformance.samples.length, 80);
        console.log('PASS workspace poster identity, bounded storage and timing samples');
    }
    {
        const events = [], messages = [], handlers = {}, mounts = [];
        const { document, nodes } = fakeDocument(events);
        const documentHandlers = {};
        document.addEventListener = (type, fn) => { documentHandlers[type] = fn; };
        let active = 0, maximum = 0;
        const parent = { postMessage: message => messages.push(message) };
        const timers = new Set();
        const schedule = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
        const box = { document, parent, performance, console, Uint8Array,
            setTimeout: schedule, clearTimeout: id => { clearTimeout(id); timers.delete(id); },
            requestAnimationFrame: fn => schedule(() => fn(performance.now()), 1), cancelAnimationFrame: clearTimeout,
            addEventListener: (type, fn) => { handlers[type] = fn; }, matchMedia: () => ({ matches: false }),
            WebWallGL: { bytesSource: () => ({}), mount: async (host, options) => {
                active++; maximum = Math.max(maximum, active); events.push('mount'); mounts.push(options);
                let destroyed = false;
                return { setFps() {}, setCoverAlign() {}, setFit() {}, pushPointer() {}, setProperties() {},
                    pause() { events.push('pause'); }, resume() { events.push('resume'); },
                    destroy() { if (!destroyed) { destroyed = true; active--; events.push('destroy'); } } };
            } }
        };
        box.window = box;
        vm.runInNewContext(fs.readFileSync('resources/wallpaper-scene.js', 'utf8'), box);
        const send = data => handlers.message({ source: parent, data });
        try {
            send({ type: 'load', token: 'first', bytes: new ArrayBuffer(2), key: 'A' });
            await waitFor(() => messages.some(message => message.type === 'scene-ready' && message.token === 'first'));
            events.length = 0;
            send({ type: 'load', token: 'second', bytes: new ArrayBuffer(2), key: 'B' });
            await waitFor(() => messages.some(message => message.type === 'scene-ready' && message.token === 'second'));
            assert.ok(events.indexOf('poster-added') < events.indexOf('destroy'), 'old frame must be covered before destruction');
            assert.equal(maximum, 1, 'no overlapping live GPU scenes');
            assert.equal(mounts[0].fps, 60);
            document.hidden = true; documentHandlers.visibilitychange(); assert.ok(events.includes('pause'));
            document.hidden = false; documentHandlers.visibilitychange(); assert.ok(events.includes('resume'));
            assert.ok(messages.find(message => message.token === 'second' && message.type === 'scene-ready').mountMs >= 0);
            send({ type: 'dispose', token: 'second' });
            assert.equal(active, 0); assert.equal(nodes.length, 0);
            send({ type: 'load', token: 'preview', bytes: new ArrayBuffer(2), key: 'C', capture: true });
            await waitFor(() => messages.some(message => message.type === 'scene-ready' && message.token === 'preview'));
            assert.equal(mounts.at(-1).fps, 24);
            send({ type: 'dispose', token: 'preview' });
            console.log('PASS poster-before-destroy, actual-ready handoff, one GPU scene and preview FPS');
        } finally { timers.forEach(clearTimeout); }
    }
    {
        const stubs = {
            vscode: { env: { appRoot: 'C:/virtual', uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 },
                Uri: { file: value => ({ with: () => ({ toString: () => 'vscode-file://vscode-app/' + value }) }) } },
            './windowBackground': { isPerWindowEnabled: () => true }, './global': {},
            './settingsStore': { SETTINGS_DIR: process.env.WALLPAPER_STUDIO_DATA_DIR }, './SudoPromptHelper': {}
        };
        const { FileDom } = loadCjs('out/FileDom.js', stubs);
        const loader = Object.create(FileDom.prototype).getLoaderJs();
        new vm.Script(loader.replace(/import\.meta\.url/g, "'file:///workbench/js-wallpaper-studio.js'"));
        const ast = ts.createSourceFile('loader.js', loader, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
        const names = new Set(['disposeScene', 'attachScenePointer', 'detachScenePointer', 'queueScenePointer', 'loadScenePackage', 'applyScene']);
        const parts = [];
        const visit = node => { if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) parts.push(node.getText(ast)); ts.forEachChild(node, visit); };
        visit(ast); assert.equal(parts.length, names.size);
        const pending = new Map(), sent = [], listeners = {}, records = new Map();
        const { document, nodes } = fakeDocument();
        document.documentElement = { addEventListener() {}, removeEventListener() {} };
        document.body.prepend = node => nodes.push(node);
        const create = document.createElement;
        document.createElement = tag => {
            const node = create(tag);
            if (tag === 'iframe') {
                node.isConnected = true;
                node.contentWindow = { postMessage: message => sent.push(message) };
                node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720 });
            }
            return node;
        };
        const target = { document, addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener() {},
            requestAnimationFrame() {}, fetch: url => new Promise(resolve => pending.set(url, resolve)),
            localStorage: { get length() { return records.size; }, key: i => [...records.keys()][i],
                getItem: key => records.get(key), setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) } };
        const box = { performance, console, Date, AbortController, sceneRendererUrl: 'renderer.html', activeCssUrl: () => 'workspace-A.css' };
        vm.runInNewContext(require('../out/sceneContinuity').SCENE_CONTINUITY_JS + '\n' + parts.join('\n'), box);
        const config = url => ({ url, title: url, properties: {}, opacity: 0.2, blur: 0, blendMode: 'lighten' });
        box.applyScene(target, config('A.pkg'));
        const state = target.__wallpaperStudioSceneState;
        const message = data => listeners.message({ source: state.frame.contentWindow, data });
        message({ type: 'renderer-ready' });
        pending.get('A.pkg')({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
        await waitFor(() => sent.some(item => item.type === 'load'));
        message({ type: 'scene-ready', token: state.token, poster: 'data:image/jpeg;base64,YQ==', mountMs: 5 });
        const frame = state.frame;
        sent.length = 0;
        box.applyScene(target, config('B.pkg'));
        assert.equal(state.frame, frame);
        assert.ok(!sent.some(item => item.type === 'dispose'), 'old scene must survive pending package fetch');
        box.applyScene(target, config('C.pkg'));
        const latest = state.token;
        pending.get('C.pkg')({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
        await waitFor(() => sent.some(item => item.type === 'load'));
        pending.get('B.pkg')({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
        await delay(10);
        assert.equal(sent.filter(item => item.type === 'load').length, 1);
        assert.equal(sent.find(item => item.type === 'load').token, latest);
        box.applyScene(target, null);
        assert.equal(target.__wallpaperStudioSceneState, undefined);
        console.log('PASS actual generated workbench handoff preserves old frame, rejects stale fetch and clears resources');
    }
    {
        const callbacks = new Set(), timers = new Set(), requests = [];
        let aborted = 0;
        const schedule = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
        const interval = (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); return id; };
        const listeners = {};
        const window = { setTimeout: schedule, clearTimeout, setInterval: interval, clearInterval,
            addEventListener: (type, fn) => { if (!listeners[type]) listeners[type] = new Set(); listeners[type].add(fn); },
            removeEventListener: (type, fn) => listeners[type]?.delete(fn) };
        const emit = (source, data) => listeners.message?.forEach(fn => fn({ source, data }));
        let frames = 0;
        const document = { addEventListener() {}, body: { appendChild() {} }, createElement: () => {
            frames++;
            const node = { style: {}, setAttribute() {}, remove() {}, contentWindow: { postMessage(message) {
                if (message.type === 'ping') schedule(() => emit(node.contentWindow, { type: 'renderer-ready' }), 0);
                if (message.type === 'load') schedule(() => emit(node.contentWindow, { type: 'scene-frame', token: message.token,
                    dataUrl: 'data:image/jpeg;base64,YQ==' }), 0);
            } } };
            return node;
        } };
        const bridge = { on: (type, fn) => { callbacks.add(fn); }, post: () => schedule(() => {
            callbacks.forEach(fn => fn({ uri: 'preview.html', nonce: 'test' }));
        }, 0) };
        const thumbnails = new Map();
        const fetch = async (url, options = {}) => {
            requests.push(url);
            if (url === 'preview.html') return { ok: true, text: async () => '<html data-wallpaper-studio-scene></html>' };
            if (url === 'slow.pkg') return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => { aborted++; reject(Error('aborted')); }, { once: true });
            });
            return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
        };
        const source = fs.readFileSync('webview/src/composables/useScenePreview.ts', 'utf8');
        const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
        const runtime = loadCjs('webview/src/composables/useScenePreview.ts', {
            vue: { reactive: value => value }, './useBridge': { useBridge: () => bridge },
            './useThumbnailCache': { getThumbnail: key => thumbnails.get(key) || '', setThumbnail: (key, value) => thumbnails.set(key, value) }
        }, { window, document, fetch, AbortController }, output);
        try {
            const preview = runtime.useScenePreview();
            const slow = preview.requestPreview('slow.pkg');
            await waitFor(() => requests.includes('slow.pkg'));
            const fast = preview.requestPreview('fast.pkg', true);
            assert.equal(await slow, null);
            assert.equal(await fast, 'data:image/jpeg;base64,YQ==');
            assert.equal(aborted, 1);
            assert.equal(preview.lastError('slow.pkg'), '');
            assert.equal(preview.isRendering('slow.pkg'), false);
            assert.ok(frames <= 2);
            runtime.disposeScenePreviewRuntime();
            console.log('PASS priority preview aborts obsolete fetch, settles both promises and releases the renderer');
        } finally { timers.forEach(clearTimeout); }
    }
    {
        const vue = require('../webview/node_modules/vue');
        const state = vue.reactive({ sourceMode: 'file', wallpaperPlaylist: [], folderImages: [],
            recentImages: Array.from({ length: 10000 }, (_, i) => ({ path: 'a-' + i + '.png', name: 'image ' + i, display: '' })) });
        const config = vue.reactive({ imagePath: '' });
        const source = fs.readFileSync('webview/src/views/LocalGalleryTab.vue', 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0] +
            '\nexport { visibleWallpapers, scrollTop, viewportHeight, windowStart };';
        const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
        const effect = vue.effectScope();
        try {
            const view = effect.run(() => loadCjs('webview/src/views/LocalGalleryTab.vue', {
                vue: { ...vue, onMounted() {}, onUnmounted() {}, onUpdated() {} }, '@element-plus/icons-vue': {},
                '../composables/useI18n': { useI18n: () => ({ t: key => key }) },
                '../composables/useBridge': { useBridge: () => ({ post() {} }) },
                '../composables/useScenePreview': { useScenePreview: () => ({ cancelQueuedExcept() {}, previewOf: () => '' }) },
                '../composables/useStore': { config, state }, '../constants': { ActionType: {} },
                '../utils/media': { isVideoPath: () => false, isWallpaperPkgPath: () => false },
                '../composables/useThumbnailCache': { getThumbnail: () => '', setThumbnail() {} }
            }, { document: { querySelectorAll: () => [] } }, output));
            assert.equal(view.visibleWallpapers.value.length, 16);
            view.scrollTop.value = 6000;
            assert.equal(view.windowStart.value, 96);
            assert.equal(view.visibleWallpapers.value[0].path, 'a-96.png');
            assert.equal(view.visibleWallpapers.value.length, 16);
            state.recentImages = [];
            await vue.nextTick();
            assert.equal(view.scrollTop.value, 0);
            assert.equal(view.visibleWallpapers.value.length, 0);
            console.log('PASS 10,000 gallery items keep a 16-row render window and clamp after filtering');
        } finally { effect.stop(); }
    }
    {
        const posts = [], values = { opacity: 0.4, blur: 8 };
        const { StudioViewProvider } = loadCjs('out/StudioViewProvider.js', {
            vscode: {}, './PickList': {}, './global': {}, './windowBackground': {
                resolveCurrentImagePath: () => '', resolveCurrentOpacity: value => value, resolveCurrentBlur: value => value },
            './settingsStore': { getAppConfig: () => ({ get: (key, fallback) => values[key] ?? fallback }) },
            './sourceMode': { normalizeSourceMode: value => value }, './thumbnailStore': {}, './scenePreview': {}, './runtimeStore': {},
            './wallpaperEngine': { hasWallpaperConfig: () => false, getWallpaperProjectProperties: () => [],
                getWallpaperProjectDeclaration: () => undefined }
        });
        const provider = Object.create(StudioViewProvider.prototype);
        Object.assign(provider, { view: { webview: { postMessage: data => posts.push(data) } }, wallpaperEntries: [],
            sourceMode: 'file', galleryRequested: true, ctx: { globalState: { get: (key, fallback) => fallback } } });
        provider.pushAppearanceState();
        assert.equal(posts[0].data.config.opacity, 0.4); assert.equal(posts[0].data.state, undefined);
        provider.pushState(false);
        assert.ok(!Object.hasOwn(posts[1].data.state, 'wallpaperPlaylist'));
        assert.ok(!Object.hasOwn(posts[1].data.state, 'recentImages'));
        console.log('PASS appearance/current-scene updates omit unchanged gallery arrays');
    }
    console.log('Performance continuity checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

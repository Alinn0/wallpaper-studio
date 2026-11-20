"use strict";
require('./test-env');
const assert = require('assert').strict;
const vm = require('vm');
const { MEDIA_HANDOFF_JS } = require('../out/mediaHandoff');
const { PRELOAD_IMAGE_JS, IMAGE_FADE_JS } = require('../out/loaderFragments');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const nodes = [], timers = new Map(), events = [], images = [];
    let next = 0;
    function element(tag) {
        const listeners = {};
        const node = { tag, style: {}, readyState: 0, paused: false,
            addEventListener: (type, fn) => { listeners[type] = fn; },
            removeEventListener: type => { delete listeners[type]; },
            emit: type => listeners[type]?.(),
            removeAttribute() {}, load() {}, pause() { this.paused = true; }, play: async () => {},
            remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); },
            requestVideoFrameCallback(fn) { this.frame = fn; return 1; }, cancelVideoFrameCallback() { this.frame = null; }
        };
        return node;
    }
    const w = { document: { createElement: element, getElementById: id => nodes.find(n => n.id === id), body: { prepend: node => nodes.push(node) } },
        requestAnimationFrame: fn => fn(), fetch: async () => ({ ok: true, blob: async () => ({}) }) };
    const box = { console: { error() {}, warn() {} }, AbortController, URL, Blob,
        setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
        Image: class { constructor() { images.push(this); } decode() { return this.decodeResult || Promise.resolve(); } },
        applyStyle: (_w, css) => events.push('style:' + css),
        notifyWallpaperRender: (_w, _config, status) => events.push(status),
        disposeScene: () => events.push('dispose-scene'),
        applyScene: (_w, config, ready, failed) => { w.__wallpaperStudioSceneState = { ready: false, frame: { style: {}, contentWindow: { postMessage() {} } }, onReady: ready, onError: failed }; }
    };
    vm.runInNewContext(PRELOAD_IMAGE_JS + MEDIA_HANDOFF_JS, box);
    return { box, w, nodes, timers, events, images };
}
async function main() {
    const f = fixture(), config = url => ({ url, opacity: .2, blur: 0, blendMode: 'lighten' });
    f.box.applyWallpaperHandoff(f.w, 'video-a', config('a.mp4'), null);
    const a = f.w.__wallpaperStudioPendingVideo;
    a.readyState = 2; a.emit('loadeddata');
    assert.equal(a.id, undefined, 'decoded but unpresented frame must not commit');
    a.frame();
    assert.equal(a.id, 'wallpaper-studio-video');
    f.box.applyWallpaperHandoff(f.w, 'video-b', config('b.mp4'), null);
    const b = f.w.__wallpaperStudioPendingVideo;
    assert.ok(f.nodes.includes(a), 'old video survives loading');
    f.box.applyWallpaperHandoff(f.w, 'video-c', config('c.mp4'), null);
    const c = f.w.__wallpaperStudioPendingVideo;
    assert.ok(!f.nodes.includes(b), 'superseded candidate released');
    c.emit('error');
    assert.ok(f.nodes.includes(a), 'decode failure keeps old video');
    f.box.applyWallpaperHandoff(f.w, 'video-d', config('d.mp4'), null);
    [...f.timers.values()].find(t => t.ms === 45000).fn();
    assert.ok(f.nodes.includes(a), 'timeout keeps old video');
    assert.equal(f.w.__wallpaperStudioPendingVideo, null);
    f.box.applyWallpaperHandoff(f.w, 'scene-e', null, config('e.pkg'));
    assert.ok(f.nodes.includes(a), 'cross-type load preserves video');
    f.w.__wallpaperStudioSceneState.onReady();
    assert.ok(!f.nodes.includes(a), 'scene ready releases previous video');
    console.log('PASS video first presentation, rapid cancellation, decode failure, timeout and video-to-scene handoff');

    const g = fixture();
    const cssA = "body::before{background-image:url('a.png')}";
    const cssB = "body::before{background-image:url('b.png')}";
    g.box.applyWallpaperHandoff(g.w, cssA, null, null);
    let decode;
    g.images[0].decodeResult = new Promise(resolve => { decode = resolve; });
    g.images[0].onload(); await tick();
    assert.equal(g.events.length, 0, 'image load is not decode completion');
    g.box.applyWallpaperHandoff(g.w, cssB, null, null);
    decode(); await tick();
    assert.equal(g.events.length, 0, 'stale image must not commit');
    g.images[1].onerror(); await tick();
    assert.ok(!g.events.some(e => e.startsWith('style:')), 'broken image retains old style and scene');
    const h = fixture();
    h.box.applyWallpaperHandoff(h.w, cssA, null, null);
    h.images[0].onload(); await tick();
    assert.ok(h.events.includes('style:' + cssA));
    assert.ok(h.events.includes('dispose-scene'));
    console.log('PASS image decode gating, stale completion rejection and failed cross-type image retention');
    const fade = fixture();
    vm.runInNewContext(IMAGE_FADE_JS, fade.box);
    const style = { textContent: cssA };
    fade.w.__bgcLastImageUrl = 'a.png';
    fade.box.bgcApplyStyleWithFade(fade.w, style, '/* scene config */');
    assert.equal(fade.w.__bgcLastImageUrl, '', 'scene must clear stale image fade identity');
    fade.box.bgcApplyStyleWithFade(fade.w, style, cssB);
    assert.equal(style.textContent, cssB, 'scene-to-image commits at full opacity');
    assert.equal(fade.timers.size, 0);
    console.log('PASS image-scene-image cannot fade in from a nonexistent old image');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

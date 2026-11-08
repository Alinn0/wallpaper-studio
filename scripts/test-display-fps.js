'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ts = require('typescript');
function load(filename, stubs = {}, globals = {}, source) {
    filename = path.resolve(filename);
    const native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(source || fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
        process, Buffer, console, setTimeout, clearTimeout, ...globals
    }, { filename });
    return module.exports;
}
class Emitter {
    constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
    fire(value) { this.listeners.forEach(fn => fn(value)); }
}
function panel(maxFps) {
    const config = { maxFps, targetFps: 60 }, frames = new Map(), timers = new Map(), listeners = new Map(), disposals = [], posts = [];
    let sequence = 0, refresh;
    const document = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
    const filename = 'webview/src/composables/useDisplayFps.ts';
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const loaded = load(filename, {
        vue: { ref: value => ({ value }), computed: read => ({ get value() { return read(); } }),
            watch(_read, callback) { refresh = () => callback(config.maxFps); refresh(); return () => {}; },
            onUnmounted: fn => disposals.push(fn) },
        './useStore': { config }, './useBridge': { useBridge: () => ({ post: msg => posts.push(msg) }) }
    }, { document, requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id), setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) }, source);
    const ui = loaded.useDisplayFps();
    function advance(fps) {
        let time = 100;
        while (frames.size) {
            const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); time += 1000 / fps;
        }
    }
    return { config, ui, frames, timers, document, listeners, posts, refresh: () => refresh(), advance,
        dispose: () => disposals.forEach(fn => fn()) };
}
async function main() {
    const waiting = panel(undefined);
    assert.equal(waiting.frames.size, 0, 'wait for shared settings before measuring');
    waiting.config.maxFps = 144; waiting.refresh();
    assert.equal(waiting.frames.size, 0, 'hydrated saved limit must skip measurement');
    waiting.dispose();
    const first = panel(0);
    first.advance(144);
    assert.equal(first.posts.length, 1); assert.equal(first.posts[0].maxFps, 144); assert.equal(first.posts[0].overwrite, false);
    first.config.maxFps = 144; first.refresh();
    first.listeners.get('visibilitychange')();
    assert.equal(first.frames.size, 0, 'visibility changes must reuse a stored limit');
    const reopened = panel(144);
    assert.equal(reopened.frames.size, 0, 'reopening the panel must reuse the limit');
    reopened.ui.sampleDisplayRate(true); reopened.advance(120);
    assert.equal(reopened.posts[0].maxFps, 120); assert.equal(reopened.posts[0].overwrite, true);
    reopened.document.hidden = true; reopened.ui.sampleDisplayRate(true);
    assert.equal(reopened.frames.size, 0);
    first.dispose(); reopened.dispose();
    const timeout = panel(0); [...timeout.timers.values()][0]();
    assert.equal(timeout.ui.fpsReadFailed.value, true); assert.equal(timeout.frames.size, 0); assert.equal(timeout.posts.length, 0);
    timeout.dispose();
    const replaced = panel(0); replaced.config.maxFps = 165; replaced.refresh();
    assert.equal(replaced.frames.size, 0, 'another host completing first must stop the redundant automatic sample'); replaced.dispose();
    console.log('PASS one initial measurement, persisted startup reuse, explicit re-read, hidden/timeout cancellation');

    const A = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
    const B = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
    const initial = A.readSettings();
    assert.equal(initial.maxFps, 0);
    await Promise.all([A.saveDisplayFps(144, false), B.saveDisplayFps(120, false)]);
    const filename = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'settings.json');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8')).maxFps;
    assert.ok(saved === 144 || saved === 120);
    await A.saveDisplayFps(240, false);
    assert.equal(A.readSettings().maxFps, saved, 'late initial result must not replace saved data');
    await B.saveDisplayFps(165, true);
    A.reloadExternalSettings(); assert.equal(A.readSettings().maxFps, 165);
    const restarted = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
    assert.equal(restarted.readSettings().maxFps, 165, 'new profile/host must load the shared disk value');
    await restarted.getAppConfig().update('targetFps', 999);
    assert.equal(restarted.readSettings().targetFps, 165);
    await restarted.saveDisplayFps(120, true);
    assert.equal(restarted.readSettings().targetFps, 120);
    const before = fs.readFileSync(filename, 'utf8');
    await assert.rejects(restarted.saveDisplayFps(NaN, true), /Invalid/);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    assert.equal(restarted.readSettings().opacity, initial.opacity);
    console.log('PASS shared disk persistence, first-writer merge, explicit replacement and shared target clamping');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

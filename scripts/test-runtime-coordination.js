'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { once } = require('events');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const service = require('../out/sceneTransport');
const coordination = require('../out/workspaceCoordination');
const { acquireFileLock } = require('../out/cancellation');
const { copyWallpaperScenePackage } = require('../out/wallpaperScene');
const requests = require('../out/displayRequests');
const root = process.env.WALLPAPER_STUDIO_DATA_DIR;
function load(file, stubs = {}) {
    const filename = path.resolve(file), native = createRequire(filename), module = { exports: {} };
    const req = name => Object.hasOwn(stubs, name) ? stubs[name] : native(name); req.resolve = native.resolve;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: req, process, Buffer, console, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
}
async function main() {
    const first = await requests.claimDisplayRequest('fenced', 'old.pkg', new AbortController().signal);
    assert.ok(first.isCurrent());
    assert.equal(await requests.claimDisplayRequest('fenced', 'auto.pkg', new AbortController().signal, true), undefined);
    const pendingSync = requests.startDisplayRequestSync();
    try {
        const takeover = `const r=require('./out/displayRequests');r.claimDisplayRequest('fenced','new.pkg',new AbortController().signal).then(q=>{if(!q.isCurrent())process.exitCode=1}).catch(e=>{console.error(e);process.exitCode=1})`;
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', takeover], { cwd: path.resolve('.'), env: process.env, windowsHide: true });
            let error = ''; child.stderr.on('data', bytes => error += bytes);
            child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(error)));
        });
        const deadline = Date.now() + 3000;
        while (!first.signal.aborted) {
            assert.ok(Date.now() < deadline, 'superseded host must abort its work');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(first.isCurrent(), false);
        await first.finish();
        assert.equal(requests.pendingDisplayRequest('fenced').path, 'new.pkg', 'old owner must not erase the new owner');
        const closing = await requests.claimDisplayRequest('fenced', '', new AbortController().signal);
        await closing.finish();
        assert.equal(requests.pendingDisplayRequest('fenced'), undefined);
        const aborted = new AbortController(); aborted.abort();
        await assert.rejects(requests.claimDisplayRequest('fenced', 'cancelled.pkg', aborted.signal), /cancelled/);
        assert.equal(requests.pendingDisplayRequest('fenced'), undefined);
    } finally { pendingSync.dispose(); }
    console.log('PASS independent hosts fence older selections, preserve the new owner and reject automatic takeover');

    const box = { console, setTimeout, clearTimeout };
    vm.runInNewContext(require('../out/sceneContinuity').SCENE_CONTINUITY_JS, box);
    const ready = await service.createRenderReceipt(undefined, 2000);
    box.notifyWallpaperRender({ WebSocket }, { receipt: ready.url }, 'ready');
    await ready.result;
    const replay = new WebSocket(ready.url); await once(replay, 'error');
    const failed = await service.createRenderReceipt(undefined, 2000);
    const rejection = assert.rejects(failed.result, /broken scene/);
    box.notifyWallpaperRender({ WebSocket }, { receipt: failed.url }, 'error', 'broken scene');
    await rejection;
    const malformed = await service.createRenderReceipt(undefined, 2000);
    const client = new WebSocket(malformed.url); await once(client, 'open');
    client.send(JSON.stringify({ path: 'not-an-allowed-command' }));
    const [code] = await once(client, 'close'); assert.equal(code, 1008);
    malformed.dispose(); await assert.rejects(malformed.result, /cancelled/);
    console.log('PASS real render receipts: ready, error, replay rejection and invalid control payload');

    const assets = path.join(root, 'cancelled-cache'); fs.mkdirSync(assets);
    const original = path.join(root, 'source.pkg'); fs.writeFileSync(original, Buffer.alloc(64, 2));
    const release = await acquireFileLock(assets);
    const controller = new AbortController();
    const waiting = copyWallpaperScenePackage(original, assets, controller.signal);
    const cancelled = assert.rejects(waiting, /cancelled/);
    controller.abort(); await cancelled;
    assert.equal(fs.readdirSync(assets).length, 0);
    await release();
    console.log('PASS cancelled cache waiter releases without copying or later acquiring the lock');

    const cancelledAfterCopy = new AbortController();
    const cancelDirectory = path.join(root, 'cancelled-commit');
    const copying = load('out/wallpaperScene.js', { fs: { ...fs, promises: { ...fs.promises,
        async rename(from, to) { await fs.promises.rename(from, to); cancelledAfterCopy.abort(); }
    } } });
    await assert.rejects(copying.copyWallpaperScenePackage(original, cancelDirectory, cancelledAfterCopy.signal), /cancelled/);
    assert.deepEqual(fs.readdirSync(cancelDirectory), [], 'cancel after rename must not strand an unindexed package');
    console.log('PASS cancellation between cache rename and index commit removes the unpublished copy');

    const A = load('out/runtimeStore.js', { './global': { getContext: () => ({ globalState: { get: (_key, fallback) => fallback } }) } });
    const B = load('out/runtimeStore.js', { './global': { getContext: () => ({ globalState: { get: (_key, fallback) => fallback } }) } });
    await A.updateRuntimeState(state => { state.workspaceImages.saved = 'old.png'; });
    const watcher = A.startRuntimeSync();
    const changed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('runtime subscription timed out')), 5000);
        const subscription = A.onDidChangeRuntime(event => {
            if (event.external) { clearTimeout(timeout); subscription.dispose(); resolve(); }
        });
    });
    await B.updateRuntimeState(state => { state.workspaceImages.saved = 'new.png'; });
    await changed; watcher.dispose();
    assert.equal(A.readRuntimeState().workspaceImages.saved, 'new.png');
    console.log('PASS independent runtime instances receive external file notifications');

    const wbRoot = path.join(root, 'app'); const wb = path.join(wbRoot, 'out/vs/workbench'); fs.mkdirSync(wb, { recursive: true });
    for (const token of ['saved', 'live', 'abandoned']) {
        const file = path.join(wb, `css-wallpaper-studio.${token}.css`);
        fs.writeFileSync(file, '/* fixture */'); fs.utimesSync(file, new Date(0), new Date(0));
    }
    const presence = coordination.startWorkspacePresence(() => 'live');
    const { collectStaleWindowCssFiles } = load('out/FileDom.js', {
        vscode: { env: { appRoot: wbRoot, uiKind: 1 }, UIKind: { Desktop: 1, Web: 2 } },
        './global': {}, './SudoPromptHelper': {}, './windowBackground': { getWindowCssFileName: () => 'css-wallpaper-studio.current.css' }
    });
    await collectStaleWindowCssFiles(); presence.dispose();
    assert.ok(fs.existsSync(path.join(wb, 'css-wallpaper-studio.live.css')));
    assert.ok(fs.existsSync(path.join(wb, 'css-wallpaper-studio.saved.css')));
    assert.ok(!fs.existsSync(path.join(wb, 'css-wallpaper-studio.abandoned.css')));
    console.log('PASS CSS cleanup preserves both recorded and active workspaces despite old mtimes');

    const counter = path.join(root, 'rotation-count.txt');
    const codeText = `const fs=require('fs');const c=require('./out/workspaceCoordination');
        c.withRotationLease('shared-fixture',60,async()=>{fs.appendFileSync(process.argv[1],'x');
        await new Promise(r=>setTimeout(r,80));await c.recordWallpaperChange('shared-fixture')}).catch(e=>{console.error(e);process.exitCode=1})`;
    const workers = [0, 1].map(() => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', codeText, counter], { cwd: path.resolve('.'), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let error = ''; child.stderr.on('data', bytes => error += bytes);
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(error)));
    }));
    await Promise.all(workers);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x');
    assert.equal(await coordination.withRotationLease('shared-fixture', 60, async () => { throw Error('too soon'); }), false);
    console.log('PASS two real host processes rotate a shared scope only once and respect the shared change time');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(service.disposeSceneTransport);

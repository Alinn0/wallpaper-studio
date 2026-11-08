'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { once } = require('events');
const WebSocket = require('ws');
const { copyWallpaperScenePackage, readWallpaperScenePackage } = require('../out/wallpaperScene');
const { registerWallpaperAsset, disposeSceneTransport } = require('../out/sceneTransport');
const { SCENE_CACHE_DIR, CACHE_ROOT } = require('../out/cachePaths');
const files = Array.from({ length: 9 }, (_, i) => path.join(CACHE_ROOT, `original-${i}.pkg`));
files.forEach((file, i) => fs.writeFileSync(file, Buffer.alloc(1024 * 32, i + 1)));
function pkgFiles() { return fs.readdirSync(SCENE_CACHE_DIR).filter(name => name.endsWith('.pkg')); }
function worker(code, args = [], ipc = false) {
    const child = spawn(process.execPath, ['-e', code, ...args], { cwd: path.resolve('.'), windowsHide: true,
        env: process.env, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    let stderr = '';
    child.stderr.on('data', data => stderr += data);
    child.done = once(child, 'exit').then(([code]) => assert.equal(code, 0, stderr));
    return child;
}
async function main() {
    await Promise.all(files.map(file => copyWallpaperScenePackage(file)));
    assert.equal(pkgFiles().length, 5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(SCENE_CACHE_DIR, 'index.json'))).length, 5);
    files.forEach((file, i) => assert.equal(fs.readFileSync(file)[0], i + 1));
    const reused = await copyWallpaperScenePackage(files[8]);
    const before = fs.statSync(reused).mtimeMs;
    assert.equal(await copyWallpaperScenePackage(files[8]), reused);
    assert.equal(fs.statSync(reused).mtimeMs, before);
    await readWallpaperScenePackage(files[0]);
    assert.equal(pkgFiles().length, 5, 'an evicted source can be recreated without exceeding quota');
    const previous = await copyWallpaperScenePackage(files[0]);
    fs.writeFileSync(files[0], Buffer.alloc(45000, 44));
    assert.notEqual(await copyWallpaperScenePackage(files[0]), previous);
    fs.unlinkSync(files[1]);
    await assert.rejects(readWallpaperScenePackage(files[1]), /ENOENT/);
    fs.writeFileSync(files[1], Buffer.alloc(32768, 2));
    console.log('PASS five-package LRU, reuse, eviction recovery, source changes and missing originals');

    const children = files.map(file => worker(`require('./out/wallpaperScene').readWallpaperScenePackage(process.argv[1]).catch(e=>{console.error(e);process.exitCode=1})`, [file]));
    await Promise.all(children.map(child => child.done));
    assert.equal(pkgFiles().length, 5);
    assert.ok(fs.readdirSync(SCENE_CACHE_DIR).every(name => name === 'index.json' || /^wallpaper-scene-[a-f0-9]{64}\.pkg$/.test(name)));
    console.log('PASS nine independent processes share one quota, bounded metadata and no temporary residue');

    const held = worker(`
        const fs=require('fs'), path=require('path');
        const read=fs.promises.readFile.bind(fs.promises);
        let first=true;
        fs.promises.readFile=async function(file,...args) {
            if(first && String(file).includes('scene-assets') && String(file).endsWith('.pkg')) {
                first=false; process.send('reading');
                await new Promise(resolve=>process.once('message',resolve));
            }
            return read(file,...args);
        };
        require('./out/wallpaperScene').readWallpaperScenePackage(process.argv[1]).then(bytes=>{
            if(bytes[0]!==2) throw Error('read corrupted'); process.disconnect();
        }).catch(e=>{console.error(e);process.exitCode=1;process.disconnect()});`, [files[1]], true);
    await once(held, 'message');
    let finished = false;
    const waiting = copyWallpaperScenePackage(files[2]).then(() => finished = true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(finished, false, 'eviction must wait for another process to finish reading');
    held.send('resume');
    await Promise.all([held.done, waiting]);
    console.log('PASS cross-process read lock prevents eviction while bytes are being consumed');

    const transportUrl = await registerWallpaperAsset('sample', () => readWallpaperScenePackage(files[2]));
    const box = { setTimeout, clearTimeout, console };
    vm.runInNewContext(require('../out/sceneContinuity').SCENE_CONTINUITY_JS, box);
    const target = { WebSocket };
    const bytes = await box.readWallpaperBytes(target, transportUrl);
    assert.deepEqual(Buffer.from(bytes), fs.readFileSync(files[2]));
    const forged = new WebSocket(transportUrl.replace(/\/[a-f0-9]{64}$/, '/invalid'));
    await once(forged, 'error');
    let release;
    const delayed = await registerWallpaperAsset('cancel', () => new Promise(resolve => release = resolve));
    const controller = new AbortController();
    const cancelled = box.readWallpaperBytes(target, delayed, controller.signal);
    const rejection = assert.rejects(cancelled, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 40));
    controller.abort();
    await rejection;
    release(Buffer.from('unused'));
    disposeSceneTransport();
    const fresh = await registerWallpaperAsset('after-restart', async () => Buffer.from('new'));
    assert.notEqual(fresh, transportUrl);
    assert.equal(Buffer.from(await box.readWallpaperBytes(target, fresh)).toString(), 'new');
    const failed = await registerWallpaperAsset('missing', async () => { throw Error('private disk path'); });
    await assert.rejects(box.readWallpaperBytes(target, failed), /closed/);
    console.log('PASS browser byte reader, rejected capabilities, cancellation, transport restart and read failure');
    const manifest = require('../package.json');
    assert.equal(manifest.contributes.views['wallpaperStudio-explorer'][0].when, undefined);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(disposeSceneTransport);

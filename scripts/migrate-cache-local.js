'use strict';
// Explicit local maintenance after the new workbench reader has passed its smoke check.
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { CACHE_ROOT, SCENE_CACHE_DIR } = require('../out/cachePaths');
const { readWallpaperScenePackage } = require('../out/wallpaperScene');
const { ensureWallpaperScenePreviewPage } = require('../out/scenePreview');
const { migrateLegacyThumbnails } = require('../out/cacheMigration');
const { registerWallpaperAsset, disposeSceneTransport } = require('../out/sceneTransport');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
    const [appRootArg, legacyRootArg] = process.argv.slice(2);
    if (!appRootArg || !legacyRootArg) throw Error('Usage: node scripts/migrate-cache-local.js <VS Code app root> <legacy global storage>');
    const appRoot = fs.realpathSync(appRootArg);
    assert.ok(fs.existsSync(path.join(appRoot, 'product.json')), 'explicit target must be a VS Code app root');
    const assets = path.resolve(appRoot, 'out/vs/workbench/wallpaper-studio-assets');
    assert.ok(assets.startsWith(appRoot + path.sep));
    assert.equal(path.basename(assets), 'wallpaper-studio-assets');
    const runtime = JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, 'runtime.json'), 'utf8'));
    const sources = [...new Set(Object.values(runtime.workspaceImages || {}).filter(file => /\.pkg$/i.test(file) && fs.existsSync(file)))].slice(-5);
    assert.ok(sources.length, 'at least one original scene is required before deleting old copies');
    const originalSignatures = sources.map(file => [file, fs.statSync(file).size, fs.statSync(file).mtimeMs]);
    let verifiedBytes = 0;
    for (const source of sources) {
        const url = await registerWallpaperAsset('migrate:' + source, () => readWallpaperScenePackage(source));
        const socket = new WebSocket(url, { maxPayload: 1024 * 1024 * 1024 });
        const bytes = await new Promise((resolve, reject) => { socket.once('message', resolve); socket.once('error', reject); });
        socket.close();
        assert.equal(hash(bytes), hash(await fs.promises.readFile(source)), 'transport must preserve the complete original package');
        verifiedBytes += bytes.length;
    }
    await migrateLegacyThumbnails(legacyRootArg);
    const preview = await ensureWallpaperScenePreviewPage(path.resolve('.'), CACHE_ROOT);
    assert.ok(fs.statSync(preview.filePath).size > 1000);
    let removed = 0, reclaimed = 0;
    if (fs.existsSync(assets)) {
        // Only content-hash-named plugin copies. Never recurse into directories or follow links.
        for (const item of fs.readdirSync(assets, { withFileTypes: true })) {
            if (!item.isFile() || !/^wallpaper-scene-[a-f0-9]{64}\.pkg(?:\.[0-9]+\.[a-f0-9]+\.tmp)?$/.test(item.name)) continue;
            const target = path.resolve(assets, item.name);
            assert.equal(path.dirname(target), assets);
            reclaimed += fs.statSync(target).size;
            fs.unlinkSync(target); removed++;
        }
    }
    const oldPreview = path.join(path.resolve(legacyRootArg), 'scene-preview');
    if (path.resolve(oldPreview) !== path.dirname(preview.filePath)) {
        for (const name of ['wallpaper-studio-scene.html', 'wallpaper-studio-scene.stamp']) {
            const file = path.join(oldPreview, name);
            if (fs.existsSync(file) && fs.lstatSync(file).isFile()) fs.unlinkSync(file);
        }
    }
    const packages = fs.readdirSync(SCENE_CACHE_DIR).filter(name => name.endsWith('.pkg'));
    assert.ok(packages.length <= 5);
    for (const [file, size, mtime] of originalSignatures) {
        assert.equal(fs.statSync(file).size, size); assert.equal(fs.statSync(file).mtimeMs, mtime);
    }
    console.log(JSON.stringify({ cacheRoot: CACHE_ROOT, packages: packages.length, verifiedBytes,
        oldApplicationCopiesRemoved: removed, bytesReclaimed: reclaimed, originalsUntouched: sources.length }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(disposeSceneTransport);

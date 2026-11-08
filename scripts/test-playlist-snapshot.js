'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('../out/wallpaperEngine');
const snapshots = require('../out/playlistSnapshot');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'playlist-snapshot-'));
    const project = path.join(directory, 'video'); fs.mkdirSync(project);
    const media = path.join(project, 'video.mp4'); fs.writeFileSync(media, 'fixture');
    const metadata = path.join(project, 'project.json');
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(metadata, JSON.stringify({ type: 'video', file: 'video.mp4', title: 'First title' }));
    fs.writeFileSync(config, JSON.stringify({ Alice: { general: { wallpaperconfig: { selectedwallpapers: { Monitor0: { playlist: { items: [media] } } } } } } }));
    snapshots.clearPlaylistSnapshot();
    const firstProgress = [];
    assert.equal((await engine.readWallpaperPlaylistAsync(config, [], 'Alice', (...v) => firstProgress.push(v)))[0].title, 'First title');
    assert.ok(firstProgress.length >= 2);
    engine.clearWallpaperProjectCache();
    const read = fs.readFileSync, reads = [];
    fs.readFileSync = function(file, ...args) { reads.push(String(file)); return read.call(this, file, ...args); };
    try {
        const progress = [];
        assert.equal((await engine.readWallpaperPlaylistAsync(config, [], 'Alice', (...v) => progress.push(v)))[0].title, 'First title');
        assert.ok(!reads.includes(metadata) && !reads.includes(config), 'valid disk snapshot reuses all metadata without reopening config/projects');
        assert.deepEqual(progress, [[1, 1]], 'cache hit does not replay per-item parsing progress');
    } finally { fs.readFileSync = read; }
    fs.writeFileSync(metadata, JSON.stringify({ type: 'video', file: 'video.mp4', title: 'Changed and longer title' }));
    assert.equal((await engine.readWallpaperPlaylistAsync(config, [], 'Alice'))[0].title, 'Changed and longer title');
    assert.equal((await engine.readWallpaperPlaylistAsync(config, [media], 'Alice'))[0].active, false, 'removal cannot reuse another filter');
    assert.deepEqual(await engine.readWallpaperPlaylistAsync(config, [], 'Bob'), [], 'account cache must never cross users');
    const forced = [];
    await engine.readWallpaperPlaylistAsync(config, [], 'Alice', (...v) => forced.push(v), true);
    assert.ok(forced.length >= 2, 'explicit re-read bypasses disk snapshot');
    const key = snapshots.playlistSnapshotKey(config, 'Alice', []);
    const dependencies = snapshots.playlistDependencies([media]);
    const generation = snapshots.playlistSnapshotGeneration();
    snapshots.clearPlaylistSnapshot();
    snapshots.writePlaylistSnapshot(key, [], dependencies, generation);
    assert.equal(snapshots.readPlaylistSnapshot(key), undefined, 'late parse must not restore reset cache');
    fs.writeFileSync(path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'playlist-cache.json'), '{broken');
    assert.equal((await engine.readWallpaperPlaylistAsync(config, [], 'Alice'))[0].title, 'Changed and longer title', 'corrupt snapshot falls back to real source');
    console.log('PASS playlist disk snapshot reuses metadata, invalidates project/user/removal, bypasses on refresh and survives corrupt/reset cache');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

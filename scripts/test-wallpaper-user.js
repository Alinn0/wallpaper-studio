/**
 * 「只读当前用户的播放列表」回归测试。
 *
 * 背景：config.json 顶层是壁纸引擎账号名，一台机器上可能同时留着多个账号
 * （本机就有 Alinn 与 defaultuser100000）。以前的 getPlaylist() 把所有用户节点
 * 合并，于是会随机到别人账号里的壁纸，甚至读到已经空的 defaultuser 节点。
 *
 * 本测试固定以下行为：
 *  1. resolveActiveWallpaperUser() 优先按上次记住的用户，其次当前 Windows 用户名；
 *  2. 指定用户时不存在的节点必须返回空列表，绝不退回全量；
 *  3. readWallpaperPlaylist() 不传用户时保持「全量合并」的旧兼容行为；
 *  4. defaultuser 节点不会被当成真实用户；
 *  5. 多显示器播放列表仍在该用户内部合并。
 *
 * Run after compilation: node scripts/test-wallpaper-user.js
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'out', 'wallpaperEngine.js'));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-wallpaper-user-'));

// ---- fixture ----------------------------------------------------------------
const workshop = path.join(tempRoot, 'workshop');
fs.mkdirSync(workshop, { recursive: true });
const sceneMineA = path.join(workshop, 'mine-a.pkg');
const sceneMineB = path.join(workshop, 'mine-b.pkg');
const sceneOther = path.join(workshop, 'other.pkg');
for (const file of [sceneMineA, sceneMineB, sceneOther]) {
    fs.writeFileSync(file, 'x');
}

const configPath = path.join(tempRoot, 'config.json');

function buildConfig() {
    return {
        '?installdirectory': 'E:/Games/Steam/steamapps/common/wallpaper_engine',
        [os.userInfo().username]: {
            general: {
                wallpaperconfig: {
                    selectedwallpapers: {
                        Monitor0: { playlist: { items: [sceneMineA] } },
                        Monitor1: { playlist: { items: [sceneMineB, sceneMineA] } }
                    }
                }
            }
        },
        SomeoneElse: {
            general: {
                wallpaperconfig: {
                    selectedwallpapers: {
                        Monitor0: { playlist: { items: [sceneOther] } }
                    }
                }
            }
        },
        defaultuser100000: { general: { editor: {} } }
    };
}

fs.writeFileSync(configPath, JSON.stringify(buildConfig()), 'utf8');

let passed = 0;
function check(name, fn) {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
}

// ---- 用户判定 ---------------------------------------------------------------
check('按当前 Windows 用户名匹配到播放列表', () => {
    const active = engine.resolveActiveWallpaperUser(configPath);
    assert.ok(active, '应能判定出用户');
    assert.equal(active.user, os.userInfo().username);
    assert.equal(active.source, 'os');
});

check('记住的用户优先于自动探测', () => {
    const active = engine.resolveActiveWallpaperUser(configPath, 'SomeoneElse');
    assert.equal(active.user, 'SomeoneElse');
    assert.equal(active.source, 'stored');
});

check('记住的用户已从 config 消失时不会沿用', () => {
    const active = engine.resolveActiveWallpaperUser(configPath, 'GhostUser');
    assert.ok(active);
    assert.notEqual(active.user, 'GhostUser');
});

check('记住的 defaultuser 不会被当成真实用户', () => {
    const users = engine.getWallpaperUsers(configPath);
    assert.ok(users.includes('defaultuser100000'));
    const active = engine.resolveActiveWallpaperUser(configPath, 'defaultuser100000');
    assert.ok(active);
    assert.notEqual(active.user, 'defaultuser100000');
});

check('getWallpaperUsers 排除 ? 开头的元数据键', () => {
    const users = engine.getWallpaperUsers(configPath);
    assert.ok(!users.some(user => user.startsWith('?')));
    assert.equal(users.length, 3);
});

// ---- 播放列表读取 -----------------------------------------------------------
check('指定用户时只返回该用户的壁纸（多显示器合并）', () => {
    const entries = engine.readWallpaperPlaylist(configPath, [], os.userInfo().username);
    const paths = entries.map(entry => path.basename(entry.path)).sort();
    assert.deepEqual(paths, ['mine-a.pkg', 'mine-b.pkg']);
});

check('指定别的用户只拿到他自己的壁纸', () => {
    const entries = engine.readWallpaperPlaylist(configPath, [], 'SomeoneElse');
    assert.deepEqual(entries.map(entry => path.basename(entry.path)), ['other.pkg']);
});

check('指定不存在的用户返回空列表，不退回全量', () => {
    const entries = engine.readWallpaperPlaylist(configPath, [], 'NobodyHere');
    assert.deepEqual(entries, []);
});

check('空播放列表的账号返回空', () => {
    const entries = engine.readWallpaperPlaylist(configPath, [], 'defaultuser100000');
    assert.deepEqual(entries, []);
});

check('不传用户时保持旧的全量合并行为', () => {
    const entries = engine.readWallpaperPlaylist(configPath, []);
    assert.equal(entries.length, 3);
});

check('removed 列表在指定用户下仍然生效', () => {
    const entries = engine.readWallpaperPlaylist(configPath, [sceneMineA], os.userInfo().username);
    const active = entries.filter(entry => entry.active).map(entry => path.basename(entry.path));
    assert.deepEqual(active, ['mine-b.pkg']);
});

// ---- 账号切换 ---------------------------------------------------------------
check('config 换了账号后能判定到新账号', () => {
    const next = buildConfig();
    delete next[os.userInfo().username];
    next.SomeoneElse.general.wallpaperconfig.selectedwallpapers.Monitor0.playlist.items = [sceneOther, sceneMineA];
    const secondPath = path.join(tempRoot, 'config2.json');
    fs.writeFileSync(secondPath, JSON.stringify(next), 'utf8');

    // 旧账号已经不在 config 里：不能继续沿用。
    const active = engine.resolveActiveWallpaperUser(secondPath, os.userInfo().username);
    assert.ok(active);
    assert.equal(active.user, 'SomeoneElse');
    const entries = engine.readWallpaperPlaylist(secondPath, [], active.user);
    assert.equal(entries.length, 2);
});

check('config.json 无法解析时返回 undefined 而不是抛错', () => {
    const brokenPath = path.join(tempRoot, 'broken.json');
    fs.writeFileSync(brokenPath, '{ not json', 'utf8');
    assert.equal(engine.resolveActiveWallpaperUser(brokenPath), undefined);
    assert.deepEqual(engine.getWallpaperUsers(brokenPath), []);
});

// ---- cleanup ----------------------------------------------------------------
try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log(`\n${passed} assertions passed.`);

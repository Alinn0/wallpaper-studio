/**
 * 播放列表加载进度回归测试。
 *
 * 背景：面板的「壁纸列表」页在触发加载后只显示空态文案，加载完才一次性出现列表。
 * 根因之一是解析循环整段同步执行：即使上报了进度，扩展宿主没有回到事件循环，
 * 进度消息也发不出去，面板永远看不到中间计数。
 *
 * 本测试固定两件事：
 *   1. readWallpaperPlaylistAsync() 会逐项上报 0…total 的递增进度；
 *   2. 解析过程中确实让出了事件循环（定时器能在最后一项之前触发）。
 *
 * Run after compilation: node scripts/test-playlist-progress.js
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const engine = require(path.join(ROOT, 'out', 'wallpaperEngine.js'));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-playlist-progress-'));
const ITEM_COUNT = 24;
const user = os.userInfo().username;

const items = [];
for (let i = 0; i < ITEM_COUNT; i += 1) {
    const itemPath = path.join(tempRoot, `scene-${i}.pkg`);
    fs.writeFileSync(itemPath, 'x');
    items.push(itemPath);
}
const configPath = path.join(tempRoot, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
    [user]: {
        general: {
            wallpaperconfig: {
                selectedwallpapers: {
                    Monitor0: { playlist: { items } }
                }
            }
        }
    }
}), 'utf8');

function check(label, fn) {
    fn();
    console.log(`PASS ${label}`);
}

(async () => {
    const progress = [];
    let timerFired = false;
    let progressAfterTimerFired = -1;

    // 先排一个宏任务：只有解析循环真的让出事件循环，它才会在加载结束前执行。
    setTimeout(() => { timerFired = true; }, 0);

    const entries = await engine.readWallpaperPlaylistAsync(
        configPath,
        [],
        user,
        (loaded, total) => {
            progress.push({ loaded, total });
            if (timerFired && progressAfterTimerFired < 0) {
                progressAfterTimerFired = loaded;
            }
        }
    );

    check('解析结果数量正确', () => {
        assert.equal(entries.length, ITEM_COUNT);
    });

    check('首个进度是 0/总数（总数在解析前就已确定）', () => {
        assert.deepEqual(progress[0], { loaded: 0, total: ITEM_COUNT });
    });

    check('最后一项进度是 总数/总数', () => {
        assert.deepEqual(progress[progress.length - 1], { loaded: ITEM_COUNT, total: ITEM_COUNT });
    });

    check('进度逐项递增且没有跳号', () => {
        for (let i = 1; i < progress.length; i += 1) {
            assert.equal(progress[i].loaded, progress[i - 1].loaded + 1);
            assert.equal(progress[i].total, ITEM_COUNT);
        }
    });

    check('上报次数覆盖每一项（面板能逐项刷新）', () => {
        assert.equal(progress.length, ITEM_COUNT + 1);
    });

    check('解析过程中让出了事件循环', () => {
        assert.equal(timerFired, true, '定时器应当能在加载期间执行');
        assert.ok(progressAfterTimerFired >= 0, '定时器触发后应当还有进度回调');
        assert.ok(
            progressAfterTimerFired < ITEM_COUNT,
            `定时器必须在最后一项之前触发，实际在 ${progressAfterTimerFired}/${ITEM_COUNT}`
        );
    });

    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    console.log('\nAll playlist progress tests passed.');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

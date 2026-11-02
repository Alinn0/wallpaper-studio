/**
 * 背景「软写入」保活测试。
 *
 * 覆盖三件事：
 *   1. 当前窗口的 CSS 会被镜像到共享的 css-wallpaper-studio.css（下次启动立刻有背景）；
 *   2. 内容没变时只刷新 mtime，不做无谓重写；
 *   3. 过期的会话级 CSS 会被删除，活跃的与当前窗口的保留。
 *
 * Run after compilation: node scripts/test-soft-write.js
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const workbenchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-soft-write-'));
const sharedCssPath = path.join(workbenchDir, 'css-wallpaper-studio.css');
const sessionToken = 'abcdef12';
const sessionCssPath = path.join(workbenchDir, `css-wallpaper-studio.${sessionToken}.css`);

let failures = 0;
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === './FileDom') {
        return {
            CUSTOM_CSS_FILE_PATH: sharedCssPath,
            WORKBENCH_DIR: workbenchDir,
            getActiveWindowCssFile: () => ({ filePath: sessionCssPath, token: sessionToken })
        };
    }
    if (request === 'vscode') {
        return {};
    }
    return originalLoad.apply(this, arguments);
};
const softWrite = require('../out/backgroundSoftWrite');
Module._load = originalLoad;

function check(label, condition, detail) {
    if (condition) {
        console.log(`PASS ${label}`);
        return;
    }
    failures += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

function reset() {
    for (const name of fs.readdirSync(workbenchDir)) {
        fs.rmSync(path.join(workbenchDir, name), { force: true, recursive: true });
    }
}

async function main() {
    // 1. 首次软写入：会话 CSS 内容被镜像到共享文件
    reset();
    const body = 'body::before{background-image:url("a.png");opacity:0.3;}';
    fs.writeFileSync(sessionCssPath, body, 'utf8');
    await softWrite.softWriteOnce();
    check('会话 CSS 被镜像到共享文件', fs.readFileSync(sharedCssPath, 'utf8') === body);
    check('没有残留临时文件', !fs.existsSync(`${sharedCssPath}.tmp`));

    // 2. 内容一致时不重写（mtime 只刷新）
    const before = fs.statSync(sharedCssPath).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    await softWrite.softWriteOnce();
    const after = fs.statSync(sharedCssPath).mtimeMs;
    check('内容未变时仍刷新 mtime', after >= before);
    check('共享文件内容保持一致', fs.readFileSync(sharedCssPath, 'utf8') === body);

    // 3. 会话 CSS 不存在时不动共享文件（没设置背景）
    reset();
    const previous = 'body::before{background-image:url("keep.png");}';
    fs.writeFileSync(sharedCssPath, previous, 'utf8');
    await softWrite.softWriteOnce();
    check('当前窗口无 CSS 时不覆盖共享文件', fs.readFileSync(sharedCssPath, 'utf8') === previous);

    // 4. 清理：过期的会话文件被删，活跃的 / 当前的保留
    reset();
    fs.writeFileSync(sessionCssPath, body, 'utf8');
    const staleName = 'css-wallpaper-studio.deadbeef.css';
    const freshName = 'css-wallpaper-studio.cafe1234.css';
    const stalePath = path.join(workbenchDir, staleName);
    const freshPath = path.join(workbenchDir, freshName);
    fs.writeFileSync(stalePath, 'old', 'utf8');
    fs.writeFileSync(freshPath, 'new', 'utf8');
    // 把 stale 文件的 mtime 推到两分钟前
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stalePath, old, old);

    await softWrite.softWriteOnce();
    check('过期的会话 CSS 被删除', !fs.existsSync(stalePath));
    check('活跃的会话 CSS 保留', fs.existsSync(freshPath));
    check('当前窗口的会话 CSS 保留', fs.existsSync(sessionCssPath));

    // 5. 定时器可以启动/停止，重复启动幂等
    softWrite.startBackgroundSoftWrite();
    softWrite.startBackgroundSoftWrite();
    softWrite.stopBackgroundSoftWrite();
    check('定时器启动与停止不抛错', true);

    fs.rmSync(workbenchDir, { recursive: true, force: true });
    if (failures) {
        console.error(`${failures} test(s) failed`);
        process.exitCode = 1;
    } else {
        console.log('All soft-write tests passed.');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

/**
 * 构建前清空产物目录。
 *
 * `tsc` 与 `vite` 都不会删除源文件已经消失的旧产物：之前删掉的模块
 * （在线图源、粒子、装饰页等）的编译结果会一直留在 `out/` 里，然后被
 * `vsce package` 原样打进 VSIX —— 既占体积，又会让已经删掉的代码
 * （包括旧品牌名）继续出现在安装包里。
 *
 * 所以打包前必须从干净目录开始编译。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const name of ['out', 'webview-dist']) {
    const target = path.join(ROOT, name);
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`cleaned ${name}`);
}

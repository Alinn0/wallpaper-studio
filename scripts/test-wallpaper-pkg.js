const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWallpaperMpkgPath, isWallpaperPkgPath, parseWallpaperPkgHeader, validateWallpaperPkgFile } = require('../out/wallpaperPkg');
const { patchMediaCsp, restoreMediaCsp } = require('../out/patchCleanup');
const { cleanAppOut } = require('../out/uninstall');
const { buildWallpaperSceneHtml, buildWallpaperScenePage, copyWallpaperScenePackage, loadWallpaperSceneInputs } = require('../out/wallpaperScene');

function makeHeader(magic) {
    const magicLength = Buffer.byteLength(magic, 'ascii');
    const header = Buffer.alloc(4 + magicLength);
    header.writeUInt32LE(magicLength, 0);
    Buffer.from(magic, 'ascii').copy(header, 4);
    return header;
}

assert.strictEqual(isWallpaperPkgPath('C:\\wallpapers\\scene.PKG'), true);
assert.strictEqual(isWallpaperPkgPath('C:\\wallpapers\\scene.mpkg'), false);
assert.strictEqual(isWallpaperMpkgPath('C:\\wallpapers\\scene.MPKG'), true);
// 版本号不再限制：老包与新包都放行（容器布局自 PKGV0001 起未变）。
for (const magic of ['PKGV0001', 'PKGV0006', 'PKGV0012', 'PKGV0023', 'PKGV0024', 'PKGV0031']) {
    assert.strictEqual(parseWallpaperPkgHeader(makeHeader(magic)), magic);
}
assert.throws(() => parseWallpaperPkgHeader(makeHeader('PKGM0003')), /\.mpkg（PKGM）暂不支持/);
assert.throws(() => parseWallpaperPkgHeader(makeHeader('TEXV0005')), /不是 Wallpaper Engine 场景包/);
assert.throws(() => parseWallpaperPkgHeader(makeHeader('PKGV00X1')), /不是 Wallpaper Engine 场景包/);
assert.throws(() => parseWallpaperPkgHeader(Buffer.alloc(11)), /文件头不完整/);
assert.throws(() => parseWallpaperPkgHeader(Buffer.alloc(64)), /文件头异常/);
const shortMagicHeader = Buffer.alloc(12);
shortMagicHeader.writeUInt32LE(16, 0);
assert.throws(() => parseWallpaperPkgHeader(shortMagicHeader), /文件头不完整/);

const originalCsp = "default-src 'none'; img-src 'self' data:; media-src 'self';";
const patchedCsp = patchMediaCsp(originalCsp);
assert.match(patchedCsp, /img-src 'self' data: .*blob:/);
assert.match(patchedCsp, /media-src 'self' .*blob: data:/);
assert.match(patchedCsp, /frame-src 'self' .*vscode-file:/);
assert.strictEqual(patchMediaCsp(patchedCsp), patchedCsp);
assert.strictEqual(restoreMediaCsp(patchedCsp), originalCsp);
const cspWithFrame = "default-src 'none'; frame-src 'self' https:; media-src 'self';";
assert.strictEqual(restoreMediaCsp(patchMediaCsp(cspWithFrame)), cspWithFrame);

const sceneTemplate = fs.readFileSync(path.join(__dirname, '..', 'resources', 'wallpaper-scene.html'), 'utf8');
const inlineSceneHtml = buildWallpaperSceneHtml(
    sceneTemplate,
    'globalThis.__testWebWallGL = true;',
    'globalThis.__testSceneRenderer = true;'
);
assert(!inlineSceneHtml.includes('__WALLPAPER_STUDIO_'));
assert(!/<script\s+src=/i.test(inlineSceneHtml));
assert(inlineSceneHtml.includes(Buffer.from('globalThis.__testWebWallGL = true;').toString('base64')));
assert(inlineSceneHtml.includes(Buffer.from('globalThis.__testSceneRenderer = true;').toString('base64')));
assert(/font-src[^;]*blob:/.test(inlineSceneHtml), 'scene page CSP must allow text-layer fonts (font-src ... blob:)');
assert.throws(() => buildWallpaperSceneHtml('<html></html>', '', ''), /must contain exactly one/);

// iframe 内脚本必须转发指针并支持首帧回传，面板预览与鼠标交互都依赖这两个协议。
const sceneScriptSource = fs.readFileSync(path.join(__dirname, '..', 'resources', 'wallpaper-scene.js'), 'utf8');
assert(sceneScriptSource.includes('pushPointer'), 'scene script must forward pointer input to the renderer');
assert(sceneScriptSource.includes('pointerLeave'), 'scene script must handle pointer leave');
assert(sceneScriptSource.includes('scene-frame'), 'scene script must post the captured first frame');
assert(sceneScriptSource.includes('capture'), 'scene script must gate frame capture behind the capture flag');
// 宿主页不可见时 rAF 会停摆，场景页必须自带定时器兜底，否则首帧永远出不来。
assert(sceneScriptSource.includes('ensureFrameClock'), 'scene script must provide a frame clock that survives invisible hosts');
assert(/window\.requestAnimationFrame = function/.test(sceneScriptSource), 'scene script must be able to swap rAF for a timer');
// 就绪通知是一次性消息，容易在宿主挂监听前丢失；面板必须能靠 ping 重新确认渲染器已就绪。
assert(sceneScriptSource.includes('renderer-ready'), 'scene script must announce renderer readiness');
assert(/type === 'ping'/.test(sceneScriptSource), 'scene script must answer readiness pings');

const scenePreviewSource = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'composables', 'useScenePreview.ts'), 'utf8');
assert(scenePreviewSource.includes('waitForRenderer'), 'panel preview must handshake instead of trusting a one-shot ready message');
assert(scenePreviewSource.includes("type: 'ping'"), 'panel preview handshake must ping the scene page');
assert(scenePreviewSource.includes('lastError'), 'panel preview must expose the failure reason to the UI');

const uninstallOut = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-studio-uninstall-test-'));
const workbenchDir = path.join(uninstallOut, 'vs', 'workbench');
fs.mkdirSync(workbenchDir, { recursive: true });
for (const fileName of [
    'wallpaper-studio-webwallgl.js',
    'wallpaper-studio-scene.html',
    'wallpaper-studio-scene.js'
]) {
    fs.writeFileSync(path.join(workbenchDir, fileName), 'generated');
}
assert.strictEqual(cleanAppOut(uninstallOut), true);
for (const fileName of [
    'wallpaper-studio-webwallgl.js',
    'wallpaper-studio-scene.html',
    'wallpaper-studio-scene.js'
]) {
    assert.strictEqual(fs.existsSync(path.join(workbenchDir, fileName)), false);
}
fs.rmSync(uninstallOut, { recursive: true, force: true });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-studio-pkg-test-'));
const validPkgPath = path.join(tempDir, 'scene.pkg');
fs.writeFileSync(validPkgPath, makeHeader('PKGV0012'));
(async () => {
    const version = await validateWallpaperPkgFile(validPkgPath);
    assert.strictEqual(version, 'PKGV0012');

    for (const magic of ['PKGV0001', 'PKGV0024']) {
        const legacyPath = path.join(tempDir, `${magic}.pkg`);
        fs.writeFileSync(legacyPath, makeHeader(magic));
        assert.strictEqual(await validateWallpaperPkgFile(legacyPath), magic);
    }
    const assetDir = path.join(tempDir, 'workbench-assets');
    const copiedPkgPath = await copyWallpaperScenePackage(validPkgPath, assetDir);
    assert.match(path.basename(copiedPkgPath), /^wallpaper-scene-[a-f0-9]{64}\.pkg$/);
    assert.deepStrictEqual(fs.readFileSync(copiedPkgPath), fs.readFileSync(validPkgPath));

    // 预览页 = workbench 注入用的同一份场景页；stamp 只随三个输入变化。
    const repoRoot = path.join(__dirname, '..');
    const first = await buildWallpaperScenePage(repoRoot);
    const second = await buildWallpaperScenePage(repoRoot);
    assert.match(first.stamp, /^[a-f0-9]{64}$/);
    assert.strictEqual(second.stamp, first.stamp, 'scene page stamp must be stable for unchanged inputs');
    assert.strictEqual(second.html, first.html);
    assert(!/<script\s+src=/i.test(first.html));
    const inputs = await loadWallpaperSceneInputs(repoRoot);
    assert(inputs.runtime.length > 1000, 'WebWallGL global bundle must be readable from node_modules');
    assert(inputs.sceneScript.includes('scene-frame'));
    console.log('Wallpaper Engine .pkg validation tests passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

require('./test-env');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWallpaperMpkgPath, isWallpaperPkgPath, parseWallpaperPkgHeader, validateWallpaperPkgFile } = require('../out/wallpaperPkg');
const { patchMediaCsp, restoreMediaCsp } = require('../out/patchCleanup');
const { cleanAppOut } = require('../out/uninstall');
const { buildWallpaperSceneHtml, buildWallpaperScenePage, copyWallpaperScenePackage, loadWallpaperSceneInputs, patchWallpaperSceneRuntime } = require('../out/wallpaperScene');

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
// XY 视角必须走投影窗口对齐：不能再靠扩大宿主 / CSS 缩放模拟移动。
assert(sceneScriptSource.includes('setCoverAlign('), 'scene script must apply XY through cover alignment');
assert(sceneScriptSource.includes('installFitGuard'), 'scene script must reapply XY after the renderer resets cover alignment');
assert(!/scale\(\s*0?\.5\s*\)/.test(sceneScriptSource), 'scene script must not fake pan with CSS scale');
assert(!sceneScriptSource.includes("'200%'"), 'scene script must not enlarge the host to pan');

const scenePreviewSource = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'composables', 'useScenePreview.ts'), 'utf8');
assert(scenePreviewSource.includes('waitForRenderer'), 'panel preview must handshake instead of trusting a one-shot ready message');
assert(scenePreviewSource.includes("type: 'ping'"), 'panel preview handshake must ping the scene page');
assert(scenePreviewSource.includes('lastError'), 'panel preview must expose the failure reason to the UI');

// 列表加载进度必须显示在空态位置，并且加载期间不再显示旧列表。
const gallerySource = fs.readFileSync(path.join(__dirname, '..', 'webview', 'src', 'views', 'LocalGalleryTab.vue'), 'utf8');
assert(gallerySource.includes('isLoadingPlaylist'), 'gallery must derive a loading flag for the playlist');
assert(
    /if \(isLoadingPlaylist\.value\) \{ return \[\]; \}/.test(gallerySource),
    'gallery must hide the stale playlist while loading so the progress text is what users see'
);
assert(
    gallerySource.includes('!state.wallpaperLoadedOnce'),
    'gallery must treat "never loaded yet" as loading instead of showing the empty state'
);
assert(
    gallerySource.includes('const total = state.wallpaperTotal > 0 ? String(state.wallpaperTotal) : \'?\''),
    'gallery must show 0/? until the total is known'
);
assert(
    /:description="displayLoadingDescription \|\| emptyDescription"/.test(gallerySource) ||
    (gallerySource.includes('playlist-loading') && gallerySource.includes('{{ displayLoadingDescription }}')),
    'gallery loading text must replace the empty-playlist description in place'
);
assert(
    gallerySource.includes('playlist-loading-icon'),
    'gallery must render a spinner in the empty state while loading'
);

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

    // 运行时补丁：setCoverAlign 只能注入一次，且要同步 DOM object-position。
    assert(inputs.runtime.includes('setCoverAlign(x, y)'), 'WebWallGL runtime must expose setCoverAlign');
    assert(inputs.runtime.includes('objectPosition'), 'setCoverAlign must sync DOM object-position');
    assert.strictEqual(
        inputs.runtime.split('/* wallpaper-studio-cover-align */').length - 1,
        1,
        'cover alignment patch must be injected exactly once'
    );
    assert.strictEqual(
        patchWallpaperSceneRuntime(inputs.runtime),
        inputs.runtime,
        'cover alignment patch must be idempotent'
    );
    assert.throws(
        () => patchWallpaperSceneRuntime('var nothingPatchable = true;'),
        /patchable scene instance API/,
        'missing runtime API must fail loudly instead of silently degrading'
    );

    // 插入点必须落在真正的实例方法上：不能把 setProperties 的形参当成运行时对象。
    const alignMarker = '/* wallpaper-studio-cover-align */';
    const alignStart = inputs.runtime.indexOf(alignMarker);
    const setPropertiesAt = inputs.runtime.indexOf('setProperties(', alignStart);
    const snippet = inputs.runtime.slice(alignStart, setPropertiesAt);
    const setPropertiesParam = /setProperties\(([A-Za-z_$][\w$]*)\)/.exec(
        inputs.runtime.slice(setPropertiesAt, setPropertiesAt + 60)
    )[1];
    const receiver = /([A-Za-z_$][\w$]*)\.coverAlign\.x = ax/.exec(snippet)[1];
    assert.notStrictEqual(
        receiver,
        setPropertiesParam,
        'cover alignment patch must target the runtime object, not the setProperties parameter'
    );
    const alignRuntime = {
        coverAlign: { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 },
        video: { style: {} },
        img: null
    };
    const applied = new Function(
        '__runtime',
        `const ${receiver} = __runtime; return {${snippet}};`
    )(alignRuntime);
    applied.setCoverAlign(0, 1);
    assert.deepStrictEqual(alignRuntime.coverAlign, { x: 0, y: 1, tx: 0, ty: 1 });
    assert.strictEqual(alignRuntime.video.style.objectPosition, '0.00% 100.00%', 'setCoverAlign must sync DOM object-position');
    applied.setCoverAlign(1.7, -0.3);
    assert.deepStrictEqual(alignRuntime.coverAlign, { x: 1, y: 0, tx: 1, ty: 0 }, 'setCoverAlign must clamp to 0…1');
    applied.setCoverAlign('abc', undefined);
    assert.deepStrictEqual(alignRuntime.coverAlign, { x: 0, y: 0, tx: 0, ty: 0 }, 'setCoverAlign must not propagate NaN');
    console.log('Wallpaper Engine .pkg validation tests passed.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

'use strict';
// Optional integration check: launches a separate, disposable VS Code profile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
async function main() {
    const executable = process.env.WALLPAPER_STUDIO_CODE_EXECUTABLE;
    if (!executable || !fs.existsSync(executable)) throw Error('Set WALLPAPER_STUDIO_CODE_EXECUTABLE to Code.exe.');
    const temp = process.env.WALLPAPER_STUDIO_SMOKE_REUSE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-studio-smoke-'));
    const state = path.join(temp, 'state');
    fs.mkdirSync(state, { recursive: true });
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const fpsCheck = process.env.WALLPAPER_STUDIO_SMOKE_FPS === '1';
    const cacheCheck = !!process.env.WALLPAPER_STUDIO_SMOKE_CACHE;
    const fresh = !fs.existsSync(path.join(state, 'settings.json'));
    if (fresh) fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ version: 3, imagePath: '', autoStatus: false, perWindowBackground: true, ...((fpsCheck || cacheCheck) ? { maxFps: 144 } : {}) }));
    const fixture = path.join(state, 'preview.png');
    if (fresh && (fpsCheck || cacheCheck)) { fs.writeFileSync(fixture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNIQAAAAASUVORK5CYII=', 'base64')); }
    const sources = [fixture, ...(cacheCheck && process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE ? [process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE] : [])];
    const lifecycle = process.env.WALLPAPER_STUDIO_SMOKE_LIFECYCLE === '1';
    const configFile = path.join(state, 'wallpaper-config.json');
    if (fresh && lifecycle) {
        const extraDir = path.join(temp, 'unvisited-wallpaper'); fs.mkdirSync(extraDir);
        const other = path.join(extraDir, 'scene.pkg'); fs.copyFileSync(process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE, other);
        const items = [process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE, other, ...(process.env.WALLPAPER_STUDIO_SMOKE_VIDEO ? [process.env.WALLPAPER_STUDIO_SMOKE_VIDEO] : [])];
        fs.writeFileSync(configFile, JSON.stringify({ [os.userInfo().username]: { general: { wallpaperconfig: { selectedwallpapers: { Monitor0: { playlist: { items } } } } } } }));
    }
    if (fresh) fs.writeFileSync(path.join(state, 'library.json'), JSON.stringify({ version: 1, values: lifecycle
        ? { wallpaperStudioSourceMode: 'wallpaper', wallpaperStudioWallpaperConfig: configFile }
        : { wallpaperStudioSourceMode: 'file', ...((fpsCheck || cacheCheck) ? { wallpaperStudioLocalFiles: sources } : {}) } }));
    if (fresh && cacheCheck) {
        const key = require('crypto').createHash('md5').update(workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 8);
        fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({ version: 1, workspaceImages: { [key]: lifecycle ? process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE : fixture }, workspacePaths: { [key]: workspace } }));
    }
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const env = { ...process.env, WALLPAPER_STUDIO_DATA_DIR: state, WALLPAPER_STUDIO_SMOKE_PORT: String(port),
        WALLPAPER_STUDIO_SMOKE_RESULT: path.join(temp, 'result.json') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [
        workspace,
        '--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-workspace-trust',
        '--user-data-dir=' + path.join(temp, 'user'), '--extensions-dir=' + path.join(temp, 'extensions'),
        '--extensionDevelopmentPath=' + (process.env.WALLPAPER_STUDIO_SMOKE_EXTENSION_PATH || path.resolve('.')), '--extensionTestsPath=' + path.join(__dirname, 'smoke-extension.cjs'),
        '--remote-debugging-port=' + port
    ], { env, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    console.log('Isolated smoke artifacts:', temp);
    if (fs.existsSync(env.WALLPAPER_STUDIO_SMOKE_RESULT)) console.log(fs.readFileSync(env.WALLPAPER_STUDIO_SMOKE_RESULT, 'utf8'));
    if (code !== 0 || !fs.existsSync(env.WALLPAPER_STUDIO_SMOKE_RESULT)) throw Error('Isolated VS Code smoke failed: ' + code);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

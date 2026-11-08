'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function getJson(url) {
    return new Promise((resolve, reject) => http.get(url, response => {
        let text = ''; response.on('data', bytes => text += bytes);
        response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    }).on('error', reject));
}
async function connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let seq = 0;
    const pending = new Map();
    const notifications = [];
    socket.on('message', bytes => {
        const data = JSON.parse(bytes.toString());
        if (data.method) { notifications.push(data); return; }
        const callback = pending.get(data.id);
        if (callback) { pending.delete(data.id); data.error ? callback.reject(Error(data.error.message)) : callback.resolve(data.result); }
    });
    return { socket, notifications, call: (method, params, sessionId) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }) };
}
exports.run = async function() {
    const extension = vscode.extensions.getExtension('Alin0907.wallpaper-studio');
    assert.ok(extension);
    await extension.activate();
    assert.equal(extension.isActive, true);
    const runtime = name => {
        const file = path.join(extension.extensionPath, 'out', name + '.js');
        // VS Code's extension loader normalizes drive letters. Node's Windows
        // module cache still treats differently cased paths as distinct modules.
        const loaded = Object.keys(require.cache).find(key => key.toLowerCase() === file.toLowerCase());
        return require(loaded || file);
    };
    const context = runtime('global').getContext();
    assert.ok(context.globalState.get);
    assert.equal(context.asAbsolutePath('resources').toLowerCase(), path.join(extension.extensionPath, 'resources').toLowerCase());
    const cacheProbe = { diskReads: 0, diskHits: 0, generated: 0, renderRequests: 0, ready: 0, playlistReads: 0, metadataDiskHits: 0 };
    let studio;
    if (process.env.WALLPAPER_STUDIO_SMOKE_CACHE) {
        const snapshots = runtime('playlistSnapshot'), readSnapshot = snapshots.readPlaylistSnapshot;
        snapshots.readPlaylistSnapshot = function(...args) { const result = readSnapshot.apply(this, args); if (result) cacheProbe.metadataDiskHits++; return result; };
        const engine = runtime('wallpaperEngine'), readPlaylist = engine.readWallpaperPlaylistAsync;
        engine.readWallpaperPlaylistAsync = function(...args) { cacheProbe.playlistReads++; return readPlaylist.apply(this, args); };
        const { ThumbnailStore } = runtime('thumbnailStore');
        const snapshot = ThumbnailStore.prototype.snapshot;
        ThumbnailStore.prototype.snapshot = async function(...args) {
            const data = await snapshot.apply(this, args); cacheProbe.diskReads++; cacheProbe.diskHits += Object.keys(data).length; return data;
        };
        const { StudioViewProvider } = runtime('StudioViewProvider');
        const handle = StudioViewProvider.prototype.handleMessage;
        StudioViewProvider.prototype.handleMessage = function(message) {
            studio = this;
            if (message?.type === 'cacheThumbnail') cacheProbe.generated++;
            if (message?.type === 'scenePreviewPage') cacheProbe.renderRequests++;
            if (message?.type === 'ready') cacheProbe.ready++;
            return handle.call(this, message);
        };
        const navigate = StudioViewProvider.prototype.navigate;
        StudioViewProvider.prototype.navigate = function(...args) { studio = this; return navigate.apply(this, args); };
    }
    await vscode.commands.executeCommand('wallpaperStudio.studio.focus');
    await delay(1800);
    const pages = await getJson('http://127.0.0.1:' + process.env.WALLPAPER_STUDIO_SMOKE_PORT + '/json/list');
    const workbench = pages.find(page => page.type === 'page' && /workbench/.test(page.url));
    assert.ok(workbench, 'isolated workbench target exists');
    const client = await connect(workbench.webSocketDebuggerUrl);
    async function evaluate(expression) {
        const result = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 65000 });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    }
    try {
        const ui = await evaluate(`({ labels: Array.from(document.querySelectorAll('.activitybar [aria-label]')).map(e=>e.getAttribute('aria-label')), frames: document.querySelectorAll('iframe').length, text: document.body.innerText })`);
        assert.ok(ui.labels.some(label => /Wallpaper Studio/.test(label)), 'activity bar icon is visible');
        assert.ok(/Studio/.test(ui.text), 'Studio view is open');
        assert.ok(ui.frames > 0, 'Studio webview was resolved');
        const report = { active: extension.isActive, sidebar: true, webviewFrames: ui.frames };
        if (process.env.WALLPAPER_STUDIO_SMOKE_FPS === '1') {
            const settingsFile = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'settings.json');
            if (process.env.WALLPAPER_STUDIO_SMOKE_FPS === '1') assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).maxFps, 144, 'startup must reuse the seeded shared limit');
            await client.call('Runtime.enable');
            const targets = await client.call('Target.getTargets');
            for (const target of targets.targetInfos.filter(target => target.type === 'iframe' || /webview/.test(target.url))) {
                try {
                    const attached = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                    await client.call('Runtime.enable', {}, attached.sessionId);
                } catch { /* Same-process frames are already included. */ }
            }
            let frame;
            for (const entry of client.notifications.filter(entry => entry.method === 'Runtime.executionContextCreated').reverse()) {
                try {
                    const result = await client.call('Runtime.evaluate', { expression: '!!window.__wallpaperStudioThumbnailStats && !!document.querySelector(".fps-controls")', contextId: entry.params.context.id, returnByValue: true }, entry.sessionId);
                    if (result.result?.value) { frame = entry; break; }
                } catch { /* Ignore unrelated renderer contexts. */ }
            }
            assert.ok(frame, 'Studio FPS controls exist in a live webview');
            const inPanel = async expression => {
                for (let attempt = 0; attempt < 4; attempt++) {
                    try {
                        const result = await client.call('Runtime.evaluate', { expression, contextId: frame.params.context.id, returnByValue: true, awaitPromise: true }, frame.sessionId);
                        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
                        return result.result.value;
                    } catch (error) {
                        if (!/context|Session|target.*closed/i.test(error.message)) throw error;
                        if (attempt === 3) {
                            console.log('Studio debug targets:', JSON.stringify(await client.call('Target.getTargets')));
                            console.log('Studio exceptions:', JSON.stringify(client.notifications.filter(item => item.method === 'Runtime.exceptionThrown')));
                            const failurePicture = await client.call('Page.captureScreenshot', { format: 'png' });
                            fs.writeFileSync(path.join(path.dirname(settingsFile), 'failed-context.png'), Buffer.from(failurePicture.data, 'base64'));
                            throw error;
                        }
                        console.log('Rebinding Studio context:', expression.slice(0, 80));
                        await delay(150);
                        const currentTargets = await client.call('Target.getTargets');
                        for (const target of currentTargets.targetInfos.filter(target => target.type === 'iframe' || /webview/.test(target.url))) {
                            try {
                                const attached = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                                await client.call('Runtime.enable', {}, attached.sessionId);
                            } catch { /* It may already be attached. */ }
                        }
                        for (const entry of client.notifications.filter(entry => entry.method === 'Runtime.executionContextCreated').reverse()) {
                            try {
                                const check = await client.call('Runtime.evaluate', { expression: '!!window.__wallpaperStudioThumbnailStats && !!document.querySelector(".fps-controls")', contextId: entry.params.context.id, returnByValue: true }, entry.sessionId);
                                if (check.result?.value) { frame = entry; break; }
                            } catch { /* A webview frame may be replaced during resource-root updates. */ }
                        }
                    }
                }
            };
            const layout = await inPanel(`(()=>{const row=document.querySelector('.fps-setting'), label=row.querySelector('label'), input=row.querySelector('.el-input-number'), button=row.querySelector('button[aria-label]');return {label:label.textContent,font:getComputedStyle(label).fontSize,small:!!label.querySelector('small'),right:button.getBoundingClientRect().left>=input.getBoundingClientRect().right};})()`);
            assert.ok(layout.label.includes('144')); assert.equal(layout.small, false); assert.equal(layout.right, true);
            const before = fs.statSync(settingsFile).mtimeMs;
            await inPanel('document.querySelector(".fps-controls button[aria-label]").click()');
            const deadline = Date.now() + 10000;
            while (fs.statSync(settingsFile).mtimeMs <= before) {
                assert.ok(Date.now() < deadline, 'manual FPS button must persist its result'); await delay(50);
            }
            const value = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).maxFps;
            assert.ok(value >= 15);
            await delay(700);
            report.fps = { startupReused: 144, manualSaved: value, buttonRightOfInput: layout.right, unifiedLabelFont: layout.font };
            await inPanel('document.getElementById("tab-local").click()');
            await delay(700);
            const actions = await inPanel(`(()=>{const buttons=document.querySelectorAll('.wallpaper-actions button'); if(buttons.length<2)return null; const a=buttons[0].getBoundingClientRect(), b=buttons[1].getBoundingClientRect();return {gap:b.left-a.right,width:a.width,height:a.height};})()`);
            assert.ok(actions && actions.gap <= 2.1 && actions.width === 24, 'pin and delete actions must be compact');
            report.compactActions = actions;
            const picture = await client.call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(path.dirname(settingsFile), 'compact-actions.png'), Buffer.from(picture.data, 'base64'));
            await inPanel('document.getElementById("tab-home").click()');
            await delay(300);
            const homePicture = await client.call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(path.dirname(settingsFile), 'fps-controls.png'), Buffer.from(homePicture.data, 'base64'));
        }
        if (process.env.WALLPAPER_STUDIO_SMOKE_CACHE) {
            const warm = process.env.WALLPAPER_STUDIO_SMOKE_CACHE === 'warm';
            const scene = process.env.WALLPAPER_STUDIO_SMOKE_CACHE_SCENE;
            await vscode.commands.executeCommand('wallpaperStudio.home');
            assert.ok(studio);
            if (!warm && scene) assert.equal(await runtime('PickList').PickList.applyBackgroundPath(scene, { silent: true }), true);
            const indexFile = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'thumbnails/index.json');
            const readIndex = () => { try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; } };
            const deadline = Date.now() + 60000;
            if (!warm) {
                while (!Object.keys(readIndex()).some(key => key.startsWith('scene:') && key.includes('#'))) {
                    assert.ok(Date.now() < deadline, 'first home scene preview must be stored on disk'); await delay(100);
                }
            }
            await delay(1000);
            const homeImage = await client.call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'cache-home.png'), Buffer.from(homeImage.data, 'base64'));
            let homeContext;
            if (process.env.WALLPAPER_STUDIO_SMOKE_LIFECYCLE === '1') {
                await client.call('Runtime.enable');
                const targets = await client.call('Target.getTargets');
                for (const target of targets.targetInfos.filter(target => target.type === 'iframe')) {
                    try {
                        const attached = await client.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                        await client.call('Runtime.enable', {}, attached.sessionId);
                    } catch { /* Already attached. */ }
                }
                for (const entry of client.notifications.filter(entry => entry.method === 'Runtime.executionContextCreated').reverse()) {
                    try {
                        const check = await client.call('Runtime.evaluate', { expression: `(()=>{const img=document.querySelector('.home-tab .preview-frame img'); if(!img)return false;window.__smokeHomePreview={img,src:img.src};window.__smokeWrongMode=false;new MutationObserver(()=>{if(document.querySelector('.actions-bar .el-button--primary'))window.__smokeWrongMode=true}).observe(document.body,{subtree:true,childList:true,attributes:true});return true})()`, contextId: entry.params.context.id, returnByValue: true }, entry.sessionId);
                        if (check.result?.value) { homeContext = entry; break; }
                    } catch { /* Another frame. */ }
                }
                assert.ok(homeContext, 'home preview must exist before opening the list');
            }
            const readyBeforeList = cacheProbe.ready;
            studio.navigate('local');
            await delay(1800);
            if (!warm && process.env.WALLPAPER_STUDIO_SMOKE_LIFECYCLE === '1') {
                while (Object.keys(readIndex()).filter(key => key.startsWith('scene:') && !key.includes('#')).length < 2) {
                    assert.ok(Date.now() < deadline, 'both scene previews must finish and reach disk'); await delay(100);
                }
            }
            assert.equal(cacheProbe.ready, readyBeforeList, 'opening the list must not recreate the Studio document');
            if (process.env.WALLPAPER_STUDIO_SMOKE_VIDEO) {
                if (homeContext) {
                    const diagnostic = await client.call('Runtime.evaluate', { expression: `({rows:[...document.querySelectorAll('.wallpaper-row')].map(r=>({title:r.querySelector('strong')?.innerText,preview:r.querySelector('.wallpaper-preview')?.tagName})),stats:window.__wallpaperStudioThumbnailStats,videos:[...document.querySelectorAll('.wallpaper-list video')].map(v=>({src:v.src,ready:v.readyState,network:v.networkState,error:v.error?.message,requested:v.dataset.thumbRequested,rects:v.getClientRects().length}))})`, contextId: homeContext.params.context.id, returnByValue: true }, homeContext.sessionId);
                    console.log('Video preview diagnostics:', JSON.stringify(diagnostic.result?.value));
                }
                while (!Object.keys(readIndex()).some(key => key.startsWith('video:'))) {
                    assert.ok(Date.now() < deadline, 'unselected playlist video must generate and persist its preview'); await delay(100);
                }
                assert.equal(runtime('windowBackground').resolveCurrentImagePath(), scene, 'video preview must not select that wallpaper');
                report.unselectedVideoCached = true;
            }
            if (homeContext) {
                for (let i = 0; i < 3; i++) { studio.navigate('home'); await delay(100); studio.navigate('local'); await delay(100); }
                await vscode.commands.executeCommand('workbench.action.closeSidebar');
                await vscode.commands.executeCommand('wallpaperStudio.studio.focus'); await delay(300);
                assert.equal(cacheProbe.ready, readyBeforeList, 'switching tabs and hiding/reopening Studio must retain its document');
                assert.equal(cacheProbe.playlistReads, 1, 'account discovery and repeated tabs must not restart playlist parsing');
                const check = await client.call('Runtime.evaluate', { expression: `(()=>{const before=window.__smokeHomePreview,img=document.querySelector('.home-tab .preview-frame img');return !!before&&before.img===img&&before.src===img.src&&!window.__smokeWrongMode})()`, contextId: homeContext.params.context.id, returnByValue: true }, homeContext.sessionId);
                assert.equal(check.result?.value, true, 'opening the list must retain the exact home image element and source');
                report.homePreviewRetained = true;
            }
            if (process.env.WALLPAPER_STUDIO_SMOKE_LIFECYCLE !== '1') assert.ok(Object.keys(readIndex()).some(key => key.startsWith('image:')));
            assert.ok(Object.keys(readIndex()).some(key => key.startsWith('scene:')));
            if (warm) {
                if (process.env.WALLPAPER_STUDIO_SMOKE_LIFECYCLE === '1') assert.ok(cacheProbe.metadataDiskHits >= 1, 'restart reuses the full playlist metadata from disk');
                assert.equal(cacheProbe.generated, 0, 'real restart must not regenerate home/list thumbnails');
                assert.equal(cacheProbe.renderRequests, 0, 'real restart must not request the preview renderer');
                assert.ok(cacheProbe.diskHits >= 2, 'real restart must read cached scene and image frames');
            }
            const listImage = await client.call('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'cache-list.png'), Buffer.from(listImage.data, 'base64'));
            report.cache = { phase: warm ? 'warm' : 'cold', ...cacheProbe, diskEntries: Object.keys(readIndex()).length };
        }
        if (process.env.WALLPAPER_STUDIO_SMOKE_SCENE) {
            const source = process.env.WALLPAPER_STUDIO_SMOKE_SCENE;
            const selection = runtime('backgroundSelection');
            const windowState = runtime('windowBackground');
            const { FileDom } = runtime('FileDom');
            const { PickList } = runtime('PickList');
            const originalInstall = FileDom.prototype.install;
            const current = windowState.resolveCurrentImagePath();
            let release;
            FileDom.prototype.install = () => new Promise(resolve => release = resolve);
            try {
                const pending = PickList.applyBackgroundPath(source);
                assert.equal(selection.getPendingBackgroundSelection(windowState.getWorkspaceKey()), source);
                assert.equal(windowState.resolveCurrentImagePath(), current);
                await delay(150);
                report.selectionBeforeLoad = true;
                release(false);
                assert.equal(await pending, false);
                assert.equal(selection.getPendingBackgroundSelection(windowState.getWorkspaceKey()), undefined);
                assert.equal(windowState.resolveCurrentImagePath(), current);
            } finally { FileDom.prototype.install = originalInstall; }
            if (process.env.WALLPAPER_STUDIO_SMOKE_FULL === '1') {
                const applied = await PickList.applyBackgroundPath(source, { silent: true });
                assert.equal(applied, true, 'a real selection must wait for the actual renderer acknowledgement');
                assert.equal(windowState.resolveCurrentImagePath(), source);
                report.actualSelectionReady = true;
                const broken = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'broken-scene.pkg');
                const header = Buffer.alloc(12); header.writeUInt32LE(8); header.write('PKGV0012', 4);
                fs.writeFileSync(broken, header);
                await assert.rejects(PickList.applyBackgroundPath(broken, { silent: true }));
                assert.equal(windowState.resolveCurrentImagePath(), source, 'render failure must preserve the successful wallpaper');
                assert.equal(selection.getPendingBackgroundSelection(windowState.getWorkspaceKey()), undefined);
                report.renderFailureRolledBack = true;
                await delay(1000);
                assert.equal(await evaluate(`!!window.__wallpaperStudioSceneState && !window.__wallpaperStudioSceneState.config.title.includes('broken-scene')`), true);
                await PickList.applyBackgroundPath('', { silent: true });
            }
            const { readWallpaperScenePackage } = runtime('wallpaperScene');
            const { registerWallpaperAsset } = runtime('sceneTransport');
            const url = await registerWallpaperAsset('smoke', () => readWallpaperScenePackage(source));
            const runtimePath = path.join(vscode.env.appRoot, 'out/vs/workbench/wallpaper-studio-scene.html');
            assert.ok(fs.existsSync(runtimePath), 'installed scene runtime exists');
            const runtimeUrl = vscode.Uri.file(runtimePath).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
            const project = runtime('wallpaperEngine').getWallpaperProjectDeclaration(source);
            report.scene = await evaluate(`(async function(){
                ${runtime('sceneContinuity').SCENE_CONTINUITY_JS}
                const bytes=await readWallpaperBytes(window,${JSON.stringify(url)});
                return await new Promise((resolve,reject)=>{
                    const frame=document.createElement('iframe');
                    frame.sandbox='allow-scripts'; frame.style.cssText='position:fixed;left:0;top:0;width:640px;height:360px;opacity:0;pointer-events:none';
                    let sent=false;
                    function done(error, result) { clearTimeout(timer); clearInterval(ping); window.removeEventListener('message', receive); frame.remove(); error?reject(error):resolve(result); }
                    function receive(event) {
                        if(event.source!==frame.contentWindow) return;
                        const data=event.data||{};
                        if(data.type==='renderer-ready'&&!sent) { sent=true; frame.contentWindow.postMessage({type:'load',token:'cache-smoke',bytes:bytes,capture:true,project:${JSON.stringify(project)},properties:{},targetFps:24},'*'); }
                        if(data.type==='scene-frame') done(null,{bytes:bytes.byteLength,frameChars:data.dataUrl?data.dataUrl.length:JSON.stringify(data).length});
                        if(data.type==='scene-error'||data.type==='scene-frame-error') done(new Error(JSON.stringify(data)));
                    }
                    const timer=setTimeout(()=>done(new Error('real scene first frame timed out')),45000);
                    const ping=setInterval(()=>frame.contentWindow&&frame.contentWindow.postMessage({type:'ping'},'*'),400);
                    window.addEventListener('message',receive);frame.src=${JSON.stringify(runtimeUrl)};document.body.appendChild(frame);
                });
            })()`);
            assert.ok(report.scene.bytes > 1000);
            assert.ok(report.scene.frameChars > 1000);
        }
        fs.writeFileSync(process.env.WALLPAPER_STUDIO_SMOKE_RESULT, JSON.stringify(report, null, 2));
    } finally { client.socket.close(); }
};

/** Browser-only helpers: keep the displayed media until its replacement has a frame. */
export const MEDIA_HANDOFF_JS = String.raw`
function releaseWallpaperVideo(video) {
    if (!video) return;
    if (video.__cancel) video.__cancel();
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (video.__objectUrl) URL.revokeObjectURL(video.__objectUrl);
    video.remove();
}
function cancelPendingVideo(w) {
    const pending = w.__wallpaperStudioPendingVideo;
    w.__wallpaperStudioPendingVideo = null;
    releaseWallpaperVideo(pending);
}
function styleWallpaperVideo(video, config) {
    video.style.objectPosition = config.position || 'center';
    video.style.objectFit = config.fit || 'cover';
    video.style.opacity = String(config.opacity);
    video.style.filter = 'blur(' + config.blur + 'px)';
    video.style.mixBlendMode = config.blendMode;
}
function applyVideo(w, config, ready, failed) {
    const doc = w.document;
    const current = doc.getElementById('wallpaper-studio-video');
    cancelPendingVideo(w);
    if (!config) { releaseWallpaperVideo(current); return; }
    if (current && current.__source === config.url && current.readyState >= 2) {
        styleWallpaperVideo(current, config);
        if (ready) ready();
        return;
    }
    const video = doc.createElement('video');
    video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
    video.preload = 'auto';
    video.__source = config.url;
    video.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2;pointer-events:none';
    styleWallpaperVideo(video, config);
    video.style.opacity = '0';
    doc.body.prepend(video);
    w.__wallpaperStudioPendingVideo = video;
    const transfer = new AbortController();
    let fallbackTimer, deadline, frame, cancelled = false, finished = false, fallback = false;
    const active = () => !cancelled && w.__wallpaperStudioPendingVideo === video;
    const cleanup = () => {
        clearTimeout(fallbackTimer); clearTimeout(deadline);
        video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', error);
        if (frame !== undefined && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame);
    };
    video.__cancel = () => { cancelled = true; transfer.abort(); cleanup(); };
    const fail = reason => {
        if (!active()) return;
        cancelPendingVideo(w);
        if (failed) failed(reason);
    };
    function commit() {
        if (!active() || finished) return;
        finished = true; cleanup();
        w.__wallpaperStudioPendingVideo = null;
        releaseWallpaperVideo(current);
        video.id = 'wallpaper-studio-video';
        styleWallpaperVideo(video, config);
        if (ready) ready();
    }
    function loaded() {
        if (!active() || video.readyState < 2 || frame !== undefined) return;
        clearTimeout(fallbackTimer);
        if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(commit);
        else w.requestAnimationFrame(() => w.requestAnimationFrame(commit));
    }
    function play() { video.play().catch(error => { if (error.name !== 'AbortError') console.warn('[WallpaperStudio] Video playback:', error); }); }
    async function useBlob() {
        if (!active() || fallback || video.readyState >= 2) return;
        fallback = true;
        try {
            let blob;
            if (/^wss?:/i.test(config.url)) {
                const bytes = await readWallpaperBytes(w, config.url, transfer.signal);
                blob = new Blob([bytes], { type: new URL(config.url).searchParams.get('mime') || 'video/mp4' });
            } else {
                const response = await w.fetch(config.url, { signal: transfer.signal });
                if (!response.ok) throw Error('Video fetch failed: ' + response.status);
                blob = await response.blob();
            }
            // A direct source can become playable while the fallback fetch is in flight.
            if (!active() || video.readyState >= 2) return;
            video.__objectUrl = URL.createObjectURL(blob);
            video.src = video.__objectUrl; play();
        } catch (error) { if (!transfer.signal.aborted) fail(error); }
    }
    function error() {
        if (!fallback && /^vscode-file:/i.test(config.url)) { void useBlob(); }
        else fail(Error('Video decode failed'));
    }
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', error);
    deadline = setTimeout(() => fail(Error('Video first frame timed out')), 45000);
    if (/^wss?:/i.test(config.url)) { void useBlob(); }
    else {
        video.src = config.url; play();
        if (/^vscode-file:/i.test(config.url)) fallbackTimer = setTimeout(useBlob, 1200);
    }
}
function applyWallpaperHandoff(w, css, video, scene) {
    const key = css;
    const previous = w.__wallpaperStudioHandoff;
    if (previous && previous.key === key && !previous.failed) return;
    if (previous && previous.cancel) previous.cancel();
    cancelPendingVideo(w);
    const request = { key: key, cancelled: false, done: false, cancel: null };
    w.__wallpaperStudioHandoff = request;
    const active = () => !request.cancelled && w.__wallpaperStudioHandoff === request;
    let timer;
    request.cancel = () => { request.cancelled = true; clearTimeout(timer); };
    const fail = error => {
        if (!active() || request.done) return;
        request.done = true; request.failed = true; clearTimeout(timer);
        cancelPendingVideo(w);
        const state = w.__wallpaperStudioSceneState;
        if (scene && state) {
            if (state.fetchController) state.fetchController.abort();
            state.onReady = null; state.onError = null;
            // Invalidate an in-flight mount but keep the renderer's old poster.
            state.frame.contentWindow.postMessage({ type: 'cancel-load', token: state.token }, '*');
            state.generation++; state.loading = false; state.ready = false; state.url = ''; state.token = '';
        }
        console.error('[WallpaperStudio] Keeping previous wallpaper:', error);
        const notice = w.document.createElement('div');
        notice.textContent = 'Wallpaper could not load. Previous background kept.';
        notice.style.cssText = 'position:fixed;bottom:30px;right:16px;z-index:2147483647;padding:10px 14px;background:#252526;color:#fff;border:1px solid #777;pointer-events:none;font:12px sans-serif';
        w.document.body.prepend(notice);
        setTimeout(() => notice.remove(), 5000);
        notifyWallpaperRender(w, scene || video, 'error', String(error.message || error));
    };
    const commit = () => {
        if (!active() || request.done) return;
        request.done = true; clearTimeout(timer);
        applyStyle(w, css);
        if (!video) applyVideo(w, null);
        if (!scene) disposeScene(w, true);
        else {
            const state = w.__wallpaperStudioSceneState;
            if (state) state.frame.style.visibility = 'visible';
        }
        notifyWallpaperRender(w, scene || video, 'ready');
    };
    // Cancel superseded scene callbacks immediately, including cross-type switches.
    const oldScene = w.__wallpaperStudioSceneState;
    if (oldScene) {
        oldScene.onReady = null; oldScene.onError = null;
        if (!scene && !oldScene.ready) {
            oldScene.generation++;
            if (oldScene.fetchController) oldScene.fetchController.abort();
            oldScene.frame.contentWindow.postMessage({ type: 'cancel-load', token: oldScene.token }, '*');
            oldScene.loading = false; oldScene.url = ''; oldScene.token = '';
        }
    }
    timer = setTimeout(() => fail(Error('Wallpaper first frame timed out')), 45000);
    if (video) applyVideo(w, video, commit, fail);
    else if (scene) {
        applyScene(w, scene, commit, fail);
        const state = w.__wallpaperStudioSceneState;
        if (!oldScene && state && !state.ready) state.frame.style.visibility = 'hidden';
    } else {
        preloadBackgroundImage(css).then(commit, fail);
    }
}
`;

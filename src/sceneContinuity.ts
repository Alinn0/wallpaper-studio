/** Pure injected helpers, exercised without writing or launching a workbench. */
export const SCENE_CONTINUITY_JS = String.raw`
function notifyWallpaperRender(targetWindow, config, status, message) {
    if (!config || !config.receipt || config.__receiptSent || targetWindow.__wallpaperStudioLastReceipt === config.receipt) return;
    config.__receiptSent = true;
    targetWindow.__wallpaperStudioLastReceipt = config.receipt;
    try {
        const socket = new targetWindow.WebSocket(config.receipt);
        const deadline = setTimeout(function() { socket.close(); }, 5000);
        socket.onopen = function() { socket.send(JSON.stringify({ status: status, message: String(message || '').slice(0, 1000) })); };
        socket.onerror = function() { clearTimeout(deadline); };
        socket.onclose = function() { clearTimeout(deadline); };
    } catch (e) { console.error('[WallpaperStudio] Render confirmation failed:', e); }
}
function readWallpaperBytes(targetWindow, url, signal) {
    if (!/^wss?:/i.test(url)) {
        return targetWindow.fetch(url, { signal: signal }).then(function(response) {
            if (!response.ok) throw new Error('Wallpaper fetch failed: ' + response.status);
            return response.arrayBuffer();
        });
    }
    return new Promise(function(resolve, reject) {
        if (signal && signal.aborted) { reject(new Error('Wallpaper load cancelled')); return; }
        const socket = new targetWindow.WebSocket(url);
        socket.binaryType = 'arraybuffer';
        let settled = false;
        const timeout = setTimeout(function() { finish(new Error('Wallpaper transfer timed out')); }, 120000);
        function abort() { finish(new Error('Wallpaper load cancelled')); }
        function finish(error, bytes) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (signal) signal.removeEventListener('abort', abort);
            socket.onmessage = socket.onerror = socket.onclose = null;
            socket.close();
            if (error) reject(error); else resolve(bytes);
        }
        if (signal) signal.addEventListener('abort', abort, { once: true });
        socket.onmessage = function(event) {
            if (typeof event.data === 'string') { finish(new Error('Invalid wallpaper transfer')); return; }
            finish(null, event.data);
        };
        socket.onerror = function() { finish(new Error('Wallpaper cache connection failed')); };
        socket.onclose = function() { finish(new Error('Wallpaper transfer closed before completion')); };
    });
}
function recordWallpaperTiming(targetWindow, stage, duration) {
    const metrics = targetWindow.__wallpaperStudioPerformance || (targetWindow.__wallpaperStudioPerformance = { samples: [] });
    metrics.samples.push({ stage: stage, ms: Math.round(duration * 10) / 10, at: Date.now() });
    if (metrics.samples.length > 80) metrics.samples.shift();
}
function wallpaperSceneIdentity(config) {
    return JSON.stringify([config.url, config.properties || {}, config.project || null]);
}
function wallpaperPosterKey(scope) {
    return 'wallpaper-studio:first-frame:v1:' + scope.split('?')[0].split('#')[0];
}
function wallpaperPosterStorage(targetWindow) {
    if (!targetWindow.__wallpaperStudioPosters) {
        // Posters are only a transition aid. Persistent thumbnails belong to
        // the extension's shared cache; do not write Chromium's profile storage.
        const values = new Map();
        targetWindow.__wallpaperStudioPosters = {
            get length() { return values.size; }, key: function(i) { return Array.from(values.keys())[i]; },
            getItem: function(k) { return values.get(k); }, setItem: function(k, v) { values.set(k, v); },
            removeItem: function(k) { values.delete(k); }
        };
        try {
            const legacy = targetWindow.localStorage;
            for (let i = legacy.length - 1; i >= 0; i--) {
                const key = legacy.key(i);
                if (key && key.startsWith('wallpaper-studio:first-frame:v1:')) legacy.removeItem(key);
            }
        } catch (e) {}
    }
    return targetWindow.__wallpaperStudioPosters;
}
function saveWallpaperPoster(targetWindow, scope, config, poster) {
    if (typeof poster !== 'string' || !poster.startsWith('data:image/jpeg;base64,') || poster.length > 250000) return;
    try {
        const storage = wallpaperPosterStorage(targetWindow);
        const prefix = 'wallpaper-studio:first-frame:v1:';
        const key = wallpaperPosterKey(scope);
        const old = [];
        for (let i = 0; i < storage.length; i++) {
            const candidate = storage.key(i);
            if (candidate && candidate.startsWith(prefix) && candidate !== key) {
                let used = 0;
                try { used = JSON.parse(storage.getItem(candidate)).usedAt || 0; } catch (e) {}
                old.push({ key: candidate, usedAt: used });
            }
        }
        old.sort(function(a, b) { return b.usedAt - a.usedAt; });
        old.slice(7).forEach(function(item) { storage.removeItem(item.key); });
        storage.setItem(key, JSON.stringify({ identity: wallpaperSceneIdentity(config), poster: poster, usedAt: Date.now() }));
    } catch (e) { /* Optional cache: a disabled/full store never blocks live rendering. */ }
}
function showWallpaperPoster(targetWindow, scope, config) {
    try {
        const saved = JSON.parse(wallpaperPosterStorage(targetWindow).getItem(wallpaperPosterKey(scope)) || 'null');
        if (!saved || saved.identity !== wallpaperSceneIdentity(config) ||
            typeof saved.poster !== 'string' || !saved.poster.startsWith('data:image/jpeg;base64,') || saved.poster.length > 250000) return;
        const doc = targetWindow.document;
        let image = doc.getElementById('wallpaper-studio-startup-poster');
        if (!image) {
            image = doc.createElement('img');
            image.id = 'wallpaper-studio-startup-poster';
            image.setAttribute('aria-hidden', 'true');
            image.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;z-index:3';
            doc.body.appendChild(image);
        }
        image.style.opacity = String(config.opacity);
        image.style.filter = 'blur(' + config.blur + 'px)';
        image.style.mixBlendMode = config.blendMode;
        const startedAt = Date.now();
        image.onload = function() { recordWallpaperTiming(targetWindow, 'cached-poster-decode', Date.now() - startedAt); };
        image.src = saved.poster;
    } catch (e) { /* A cache miss never delays the real scene. */ }
}
function clearWallpaperPoster(targetWindow) {
    const image = targetWindow.document.getElementById('wallpaper-studio-startup-poster');
    if (image) image.remove();
}
`;

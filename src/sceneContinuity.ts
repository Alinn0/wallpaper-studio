/** Pure injected helpers, exercised without writing or launching a workbench. */
export const SCENE_CONTINUITY_JS = String.raw`
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
function saveWallpaperPoster(targetWindow, scope, config, poster) {
    if (typeof poster !== 'string' || !poster.startsWith('data:image/jpeg;base64,') || poster.length > 250000) return;
    try {
        const storage = targetWindow.localStorage;
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
        const saved = JSON.parse(targetWindow.localStorage.getItem(wallpaperPosterKey(scope)) || 'null');
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

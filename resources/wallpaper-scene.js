(function() {
    // The renderer runs in an opaque-origin sandbox where Cache Storage is unavailable.
    // Hide the API so WebWallGL selects its in-memory bake cache instead.
    Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true });

    /**
     * 宿主页不可见时（iframe 被放到视口之外）浏览器会停发 requestAnimationFrame，WebWallGL
     * 的渲染循环就永远产不出首帧，mount 只能等它自己的首帧看门狗报错（默认 60s）。这里先探
     * 一次：若 500ms 内没有任何 rAF 回调，就把 rAF 换成定时器版本；rAF 正常时什么都不改。
     *
     * 只在宿主页本身可见时兜底：整个页面被隐藏（例如 VS Code 最小化）属于用户主动离开，
     * 此时应当照旧让浏览器节流，避免后台空耗 CPU。
     */
    (function ensureFrameClock() {
        let alive = false;
        let patched = false;
        const nativeRequest = window.requestAnimationFrame.bind(window);
        const nativeCancel = window.cancelAnimationFrame.bind(window);
        nativeRequest(function() { alive = true; });
        window.setTimeout(function() {
            if (alive || patched) return;
            if (document.visibilityState !== 'visible') return;
            patched = true;
            // 标记给帧率探测用：rAF 已被替换成定时器，此时不能当作屏幕刷新率。
            globalThis.__wallpaperStudioFrameClockPatched = true;
            const timers = new Map();
            let counter = 0;
            window.requestAnimationFrame = function(callback) {
                const id = ++counter;
                timers.set(id, window.setTimeout(function() {
                    timers.delete(id);
                    callback(performance.now());
                }, 1000 / 30));
                return id;
            };
            window.cancelAnimationFrame = function(id) {
                const timer = timers.get(id);
                if (timer === undefined) {
                    nativeCancel(id);
                    return;
                }
                window.clearTimeout(timer);
                timers.delete(id);
            };
        }, 500);
    })();

    const host = document.getElementById('scene-host');
    let token = '';
    let generation = 0;
    let scene;
    let refreshRatePromise;
    /** 场景挂载前收到的最后一次指针，挂载后补发。 */
    let lastPointer;
    /** 最近一次生效的属性：setFit 会把 coverAlign 重置成居中，需要重新补上视角。 */
    let currentProperties = {};
    let lastPoster = '';
    let poster;
    let posterTimer;
    let mountChain = Promise.resolve();

    function showPoster(value) {
        if (!value) return;
        if (posterTimer) clearTimeout(posterTimer);
        if (!poster) {
            poster = document.createElement('img');
            poster.setAttribute('aria-hidden', 'true');
            poster.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;z-index:3';
            document.body.appendChild(poster);
        }
        poster.style.transition = 'none';
        poster.style.opacity = '1';
        poster.src = value;
    }

    function dismissPoster(expectedGeneration) {
        if (!poster) return;
        const previous = poster;
        previous.style.transition = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'none' : 'opacity 180ms ease';
        previous.style.opacity = '0';
        posterTimer = setTimeout(function() {
            if (generation !== expectedGeneration || poster !== previous) return;
            previous.remove();
            poster = undefined;
            posterTimer = undefined;
        }, 200);
    }

    function capturePoster() {
        const canvas = host.querySelector('canvas');
        if (!canvas || !canvas.width || !canvas.height) return '';
        const size = fitThumbSize(canvas.width, canvas.height);
        const thumb = document.createElement('canvas');
        thumb.width = size.width;
        thumb.height = size.height;
        const context = thumb.getContext('2d');
        if (!context) return '';
        context.drawImage(canvas, 0, 0, size.width, size.height);
        return thumb.toDataURL('image/jpeg', 0.8);
    }

    function nextPaint() {
        return new Promise(function(resolve) {
            let done = false;
            let timer;
            function finish() { if (!done) { done = true; clearTimeout(timer); resolve(); } }
            timer = setTimeout(finish, 120);
            requestAnimationFrame(finish);
        });
    }

    document.addEventListener('visibilitychange', function() {
        if (!scene) return;
        if (document.hidden) scene.pause(); else scene.resume();
    });

    /** 缩略图尺寸：首页和列表共用，背景渲染不会走这条截图链路。 */
    var THUMB_MAX_WIDTH = 640;
    var THUMB_MAX_HEIGHT = 360;

    function fitThumbSize(width, height) {
        if (!width || !height) { return { width: THUMB_MAX_WIDTH, height: THUMB_MAX_HEIGHT }; }
        var scale = Math.min(THUMB_MAX_WIDTH / width, THUMB_MAX_HEIGHT / height, 1);
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
        };
    }

    function announceReady() {
        parent.postMessage({ type: 'renderer-ready' }, '*');
    }

    function readSlider(raw, fallback) {
        var n = Number(raw);
        return isFinite(n) ? n : fallback;
    }

    function applyViewOffset(properties) {
        if (properties) { currentProperties = properties; }
        var xRaw = readSlider(currentProperties.wallpaperstudio_pan_x, 100);
        var yRaw = readSlider(currentProperties.wallpaperstudio_pan_y, 100);

        // 0…200 → 0…1；100 为居中。对齐只改变 cover 的投影窗口，
        // 不改变宿主、canvas 或视觉缩放比例。
        var alignX = Math.max(0, Math.min(1, xRaw / 200));
        var alignY = Math.max(0, Math.min(1, yRaw / 200));

        host.style.position = 'relative';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.left = '0';
        host.style.top = '0';
        host.style.transformOrigin = '';
        host.style.transform = 'none';
        if (scene && typeof scene.setCoverAlign === 'function') {
            scene.setCoverAlign(alignX, alignY);
        }
    }

    /**
     * setFit() 内部会调用 resetCoverAlign() 把视口对齐打回居中；
     * 包一层在调用后重放用户视角，避免 fit 变更把 XY 结果吃掉。
     */
    function installFitGuard(instance) {
        if (!instance || instance.__wallpaperStudioFitGuard) { return; }
        if (typeof instance.setFit !== 'function') { return; }
        var originalSetFit = instance.setFit;
        try {
            instance.setFit = function(fit) {
                var result = originalSetFit.call(instance, fit);
                applyViewOffset();
                return result;
            };
            instance.__wallpaperStudioFitGuard = true;
        } catch (e) { /* 实例只读时放弃保护，不影响渲染 */ }
    }

    window.addEventListener('message', function(event) {
        if (event.source !== parent || !event.data) return;
        const message = event.data;
        // 指针消息不带 token：宿主每帧都可能推送，省掉一次字符串比较。
        if (message.type === 'pointer') {
            if (!message.pointer) return;
            // 场景还没挂好时先记住最后一次指针，挂载完成后再补一次，
            // 否则首帧会因为「没收到过鼠标」而停在正面/中心。
            if (!scene) {
                lastPointer = message.pointer;
                return;
            }
            const pointer = message.pointer;
            if (pointer.leave) {
                scene.pointerLeave();
            } else {
                scene.pushPointer(pointer.u, pointer.v, pointer.buttons, pointer.mods);
            }
            return;
        }
        // 渲染器是否就绪不能只靠启动时那一次 postMessage：宿主可能还没挂监听器，
        // 消息就丢了。宿主会周期性 ping，这里无条件应答。
        if (message.type === 'ping') {
            announceReady();
            return;
        }
        if (message.type === 'set-properties' && scene && message.properties) {
            scene.setProperties(message.properties);
            applyViewOffset(message.properties);
            return;
        }
        if (typeof message.token !== 'string') return;
        if (message.type === 'dispose' && message.token === token) {
            generation++;
            if (scene) {
                scene.destroy({ releasePkgCache: true });
                scene = undefined;
            }
            token = '';
            currentProperties = {};
            lastPoster = '';
            if (posterTimer) clearTimeout(posterTimer);
            if (poster) poster.remove();
            poster = undefined;
            host.replaceChildren();
            return;
        }
        if (message.type !== 'load' || !message.bytes) return;
        const requestedGeneration = ++generation;
        token = message.token;
        // Serialize mounts: obsolete requests may finish, but cannot allocate a second live scene.
        mountChain = mountChain.catch(function() {}).then(function() {
            if (requestedGeneration !== generation) return;
            return loadScene(message, requestedGeneration);
        });
    });

    /**
     * 用 requestAnimationFrame 采样显示器实际刷新率，作为场景渲染的帧率上限，
     * 让动画尽量跑满屏幕刷新率（包括 60/120/144/165/240 Hz 及更高刷新率）。
     * 采样不足时使用 60；背景上限 120，缩略图固定 24，减少同时初始化的 GPU 压力。
     */
    function detectRefreshRate() {
        if (refreshRatePromise) { return refreshRatePromise; }
        refreshRatePromise = new Promise(function(resolve) {
            // rAF 已被换成定时器（宿主不可见），采样没有意义，直接跟随 rAF 逐帧渲染。
            if (globalThis.__wallpaperStudioFrameClockPatched) {
                // ensureFrameClock 的定时器是 30Hz，不能伪报成更高刷新率。
                resolve(30);
                return;
            }
            const samples = [];
            let last = 0;
            let settled = false;
            let timer = 0;
            function finish(fps) {
                if (settled) { return; }
                settled = true;
                window.clearTimeout(timer);
                resolve(fps);
            }
            function medianFps(deltas) {
                const sorted = deltas.slice().sort(function(a, b) { return a - b; });
                const median = sorted[Math.floor(sorted.length / 2)] || 16.7;
                return Math.max(24, Math.min(360, Math.round(1000 / median)));
            }
            timer = window.setTimeout(function() {
                finish(samples.length >= 3 ? medianFps(samples) : 60);
            }, 600);
            function tick(time) {
                if (settled) { return; }
                if (last) { samples.push(time - last); }
                last = time;
                if (samples.length >= 12) {
                    // 丢掉前几帧：首次渲染与页面加载的抖动会明显偏高。
                    finish(medianFps(samples.slice(3)));
                    return;
                }
                window.requestAnimationFrame(tick);
            }
            window.requestAnimationFrame(tick);
        });
        return refreshRatePromise;
    }

    async function loadScene(message, currentGeneration) {
        const startedAt = performance.now();
        if (!message.capture) {
            let snapshot = lastPoster;
            try { snapshot = capturePoster() || snapshot; } catch (e) { /* Preserve the previous cached frame. */ }
            showPoster(snapshot);
        }
        if (scene) {
            scene.destroy({ releasePkgCache: true });
            scene = undefined;
        }
        host.replaceChildren();
        try {
            const api = globalThis.WebWallGL;
            if (!api || typeof api.mount !== 'function' || typeof api.bytesSource !== 'function') {
                throw new Error('WebWallGL renderer failed to initialize.');
            }
            // Mount immediately at 60 FPS without waiting for monitor sampling.
            // Thumbnail work is capped at 24 FPS and never runs a second live scene.
            const refreshRatePromise = message.capture ? Promise.resolve(24) : detectRefreshRate();
            const instance = await api.mount(host, {
                source: api.bytesSource(
                    new Uint8Array(message.bytes),
                    // 必须带上 project.json 的属性声明：WebWallGL 只有拿到声明才会把
                    // setProperties() 的值写回 scene.json 的 {user: ...} 绑定，
                    // 否则画面不会变（值只进了脚本环境）。
                    message.project || { type: 'scene', file: 'scene.json', title: message.title },
                    'wallpaper-studio:' + message.key
                ),
                fit: 'cover',
                fps: message.capture ? 24 : 60,
                mountTimeoutMs: 30000,
                volume: 0,
                scripts: true,
                properties: message.properties || {},
                bake: false
            });
            if (currentGeneration !== generation || token !== message.token) {
                instance.destroy({ releasePkgCache: true });
                return;
            }

            scene = instance;
            currentProperties = message.properties || {};
            applyViewOffset();
            installFitGuard(instance);
            void refreshRatePromise.then(function(fps) {
                if (currentGeneration === generation && token === message.token && scene === instance) {
                    try { instance.setFps(message.capture ? 24 : Math.min(120, fps)); } catch (e) { /* renderer may be closing */ }
                }
            });
            // 补发挂载前收到的指针，首帧就能带正确的视差/鼠标跟随角度。
            if (lastPointer && !lastPointer.leave) {
                try { instance.pushPointer(lastPointer.u, lastPointer.v, lastPointer.buttons, lastPointer.mods); } catch (e) { /* 忽略 */ }
            }
            await nextPaint();
            if (currentGeneration !== generation) return;
            let firstPoster = '';
            try { firstPoster = capturePoster(); } catch (e) { /* Readback is optional. */ }
            if (firstPoster) lastPoster = firstPoster;
            parent.postMessage({ type: 'scene-ready', token: token, poster: firstPoster,
                mountMs: performance.now() - startedAt }, '*');
            dismissPoster(currentGeneration);
            if (document.hidden) instance.pause();
            if (message.capture) {
                void captureFirstFrame(currentGeneration, message.token);
            }
        } catch (error) {
            if (currentGeneration !== generation) return;
            parent.postMessage({
                type: 'scene-error',
                token: token,
                message: error instanceof Error ? error.message : String(error)
            }, '*');
        }
    }

    /** 渲染链路就绪后回传一帧画面（缩略图专用的 JPEG data URL）。 */
    async function captureFirstFrame(currentGeneration, currentToken) {
        try {
            await new Promise(function(resolve) { requestAnimationFrame(resolve); });
            await new Promise(function(resolve) { requestAnimationFrame(resolve); });
            await new Promise(function(resolve) { setTimeout(resolve, 120); });
            if (currentGeneration !== generation) return;
            const canvas = host.querySelector('canvas');
            if (!canvas) throw new Error('scene canvas is unavailable');
            // 这里仅用于 Webview 首页/列表缩略图；背景不调用 captureFirstFrame，
            // 始终使用上面的原始场景画布实时渲染。
            const size = fitThumbSize(canvas.width, canvas.height);
            let dataUrl;
            if (size.width === canvas.width && size.height === canvas.height) {
                dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            } else {
                const thumb = document.createElement('canvas');
                thumb.width = size.width;
                thumb.height = size.height;
                const context = thumb.getContext('2d');
                if (!context) throw new Error('thumbnail canvas is unavailable');
                context.drawImage(canvas, 0, 0, size.width, size.height);
                dataUrl = thumb.toDataURL('image/jpeg', 0.85);
            }
            if (currentGeneration !== generation) return;
            parent.postMessage({ type: 'scene-frame', token: currentToken, dataUrl: dataUrl }, '*');
        } catch (error) {
            if (currentGeneration !== generation) return;
            parent.postMessage({
                type: 'scene-frame-error',
                token: currentToken,
                message: error instanceof Error ? error.message : String(error)
            }, '*');
        }
    }

    announceReady();
})();

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

    /**
     * 相机视角平移 —— **纯平移，不缩放**。
     *
     * 两个滑块都是百分比语义、默认 100：
     *   panX / panY：0…200，100 居中，0 贴左/上，200 贴右/下
     *
     * 画面始终保持 100% 大小，只做位置偏移（最多半个视口），
     * 所以推到两端时会露出空白 —— 这是刻意接受的：平移和缩放彻底解耦，
     * 滑块动多少，画面就移多少，不会因为自动放大而产生"跳变"的错觉。
     *
     * 定位用 left/top（相对视口）而不是百分比 transform（相对元素自身尺寸），
     * 尺寸不变时两者等价，但 left/top 的换算更直观。
     */
    var PAN_RANGE = 50; // 端点位移：视口宽/高的 50%

    function readSlider(raw, fallback) {
        var n = Number(raw);
        return isFinite(n) ? n : fallback;
    }

    function applyViewOffset(properties) {
        var xRaw = readSlider(properties.wallpaperstudio_pan_x, 100);
        var yRaw = readSlider(properties.wallpaperstudio_pan_y, 100);

        // 0…200 → -1…1；100 为居中
        var px = Math.max(-1, Math.min(1, (xRaw - 100) / 100));
        var py = Math.max(-1, Math.min(1, (yRaw - 100) / 100));

        host.style.position = 'relative';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.left = (px * PAN_RANGE) + '%';
        host.style.top = (py * PAN_RANGE) + '%';
        // 旧版本用 transform 平移，这里显式清掉，避免两者叠加。
        host.style.transform = 'none';
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
            host.replaceChildren();
            return;
        }
        if (message.type !== 'load' || !message.bytes) return;
        void loadScene(message);
    });

    /**
     * 用 requestAnimationFrame 采样显示器实际刷新率，作为场景渲染的帧率上限，
     * 让动画尽量跑满屏幕刷新率（包括 60/120/144/165/240 Hz 及更高刷新率）。
     * 采样不足时使用 360；正常情况下采样值来自浏览器的实际屏幕同步时钟。
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
                finish(samples.length >= 3 ? medianFps(samples) : 240);
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

    async function loadScene(message) {
        const currentGeneration = ++generation;
        token = message.token;
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
            // Mount immediately at the safe upper bound. Refresh-rate sampling
            // takes several animation frames; waiting for it here leaves the
            // scene iframe black during every VS Code reload. Tune the running
            // instance once the real display rate has been measured.
            const refreshRatePromise = detectRefreshRate();
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
                fps: 360,
                volume: 0,
                scripts: true,
                properties: message.properties || {},
                bake: false
            });
            applyViewOffset(message.properties || {});
            if (currentGeneration !== generation || token !== message.token) {
                instance.destroy({ releasePkgCache: true });
                return;
            }

            scene = instance;
            void refreshRatePromise.then(function(fps) {
                if (currentGeneration === generation && token === message.token && scene === instance) {
                    try { instance.setFps(fps); } catch (e) { /* renderer may be closing */ }
                }
            });
            // 补发挂载前收到的指针，首帧就能带正确的视差/鼠标跟随角度。
            if (lastPointer && !lastPointer.leave) {
                try { instance.pushPointer(lastPointer.u, lastPointer.v, lastPointer.buttons, lastPointer.mods); } catch (e) { /* 忽略 */ }
            }
            parent.postMessage({ type: 'scene-ready', token: token }, '*');
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
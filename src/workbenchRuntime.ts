import { IMAGE_FADE_JS, PRELOAD_IMAGE_JS } from './loaderFragments';
import { SCENE_CONTINUITY_JS } from './sceneContinuity';

interface RuntimeOptions {
    escapedDesktopUrl: string;
    webCssPath: string;
    cssFileName: string;
    workbenchJsName: string;
    relativePlaceholder: string;
    bootstrapCssFileName: string;
    perWindowBackground: boolean;
    sharedCssToken: string;
}

/** Generates browser code without filesystem access or extension-host state. */
export function createWorkbenchRuntime(options: RuntimeOptions): string {
    const { escapedDesktopUrl, webCssPath, cssFileName, workbenchJsName, relativePlaceholder, bootstrapCssFileName, perWindowBackground, sharedCssToken } = options;

        const videoSetup = `
            function applyVideo(targetWindow, config) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.body) return;
                    let video = doc.getElementById('wallpaper-studio-video');
                    if (!config) {
                        if (video) {
                            if (video.__bgcTransfer) { video.__bgcTransfer.abort(); }
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                            }
                            // 清空"目标地址"，正在进行的 blob 转换回来后会自行丢弃。
                            video.__bgcWantedUrl = null;
                            video.__bgcFetchingFor = null;
                            video.remove();
                        }
                        return;
                    }
                    if (!video) {
                        video = doc.createElement('video');
                        video.id = 'wallpaper-studio-video';
                        video.autoplay = true;
                        video.loop = true;
                        video.muted = true;
                        video.playsInline = true;
                        video.preload = 'auto';
                        video.style.position = 'absolute';
                        video.style.top = '0';
                        video.style.left = '0';
                        video.style.width = '100%';
                        video.style.height = '100%';
                        video.style.objectFit = 'cover';
                        video.style.zIndex = '2';
                        video.style.pointerEvents = 'none';
                        doc.body.prepend(video);
                    } else if (!video.isConnected) {
                        // 某些工作台布局重建会把节点摘掉，重新挂回 body。
                        doc.body.prepend(video);
                    }

                    let url = config.url;
                    const loc = targetWindow.location;
                    if (loc && url.toLowerCase().startsWith('http://') && loc.protocol === 'https:') {
                        url = url.replace(/^http:\\/\\//i, 'https://');
                    }

                    if (!video.loop) video.loop = true;
                    if (!video.muted) video.muted = true;

                    video.style.objectPosition = config.position || 'center';
                    video.style.objectFit = config.fit || 'cover';
                    video.style.opacity = config.opacity + '';
                    video.style.filter = 'blur(' + config.blur + 'px)';
                    video.style.mixBlendMode = config.blendMode;

                    if (video.__bgcTransfer && video.__bgcWantedUrl !== url) { video.__bgcTransfer.abort(); }
                    if (/^wss?:/i.test(url)) {
                        if (video.__bgcWantedUrl === url) { return; }
                        video.__bgcWantedUrl = url;
                        const transfer = new AbortController();
                        video.__bgcTransfer = transfer;
                        readWallpaperBytes(targetWindow, url, transfer.signal).then(function(bytes) {
                            if (video.__bgcWantedUrl !== url || transfer.signal.aborted) return;
                            const mime = new URL(url).searchParams.get('mime') || 'video/mp4';
                            const next = URL.createObjectURL(new Blob([bytes], { type: mime }));
                            if (video.__bgcObjectUrl) URL.revokeObjectURL(video.__bgcObjectUrl);
                            video.__bgcObjectUrl = next;
                            video.src = next;
                            video.play().catch(function() {});
                        }).catch(function(error) {
                            if (video.__bgcWantedUrl === url && !transfer.signal.aborted) {
                                video.__bgcWantedUrl = null;
                                console.error('[WallpaperStudio] Video transfer failed:', error);
                            }
                        });
                        return;
                    }

                    // A6: 视频切换同样支持淡入淡出（尊重系统"减少动态效果"）
                    if (config.transition) {
                        var reducedMotion = (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
                        video.style.transition = reducedMotion ? 'none' : 'opacity .25s ease, filter .25s ease';
                    }

                    // B1: vscode-file 协议由 main.js 的 net.fetch(file://) 代理，Electron 43
                    // 起不再补 Accept-Ranges/206，Chromium 150 的 <video> 直接报
                    // "no supported sources"。把 vscode-file 的视频 fetch 成完整 blob
                    // 再用 object URL 播放，绕开协议层对 Range 的依赖。
                    //
                    // 但大文件（4K 视频动辄几百 MB）fetch 要好几秒，期间画面是空的 ——
                    // 这就是"概率不显示"的来源。所以改成：
                    //   1) 先直连，立即尝试播放；
                    //   2) 后台转 blob，成功后无缝替换（保留播放进度）；
                    //   3) 直连已经能播时跳过 blob，避免重复读盘与内存翻倍。
                    if (url.toLowerCase().startsWith('vscode-file:')) {
                        // 记录「本次应该播放的地址」。fetch 是异步的，期间用户可能已经
                        // 切到别的壁纸；回来时必须确认自己仍是当前目标，否则会把新壁纸
                        // 的 src 覆盖成旧视频。
                        video.__bgcWantedUrl = url;

                        if (video.__bgcBlobFor === url && video.__bgcObjectUrl) {
                            if (video.src !== video.__bgcObjectUrl) {
                                video.src = video.__bgcObjectUrl;
                            }
                            if (video.paused) {
                                video.play().catch(function() {});
                            }
                            return;
                        }

                        var switched = video.__bgcSourceUrl !== url;
                        if (switched) {
                            video.__bgcSourceUrl = url;
                            video.__bgcBlobFor = null;
                            video.src = url;
                        }
                        if (video.paused) {
                            video.play().catch(function(e) {
                                if (e.name !== 'AbortError') {
                                    console.error('WallpaperStudio video play error:', e);
                                }
                            });
                        }

                        if (video.__bgcFetchingFor === url) { return; }
                        video.__bgcFetchingFor = url;
                        var scheduleBlob = function(delay) {
                            setTimeout(function() {
                                if (video.__bgcWantedUrl !== url) { video.__bgcFetchingFor = null; return; }
                                // 直连已经能在播：不再重复读整段视频。
                                if (video.readyState >= 2 && !video.error) {
                                    video.__bgcFetchingFor = null;
                                    return;
                                }
                                fetch(url).then(function(r) {
                                    if (!r.ok) throw new Error('vscode-file fetch failed: ' + r.status);
                                    return r.blob();
                                }).then(function(blob) {
                                    video.__bgcFetchingFor = null;
                                    if (video.__bgcWantedUrl !== url) { return; }
                                    var nextUrl = URL.createObjectURL(blob);
                                    var prevObj = video.__bgcObjectUrl;
                                    var resumeAt = video.currentTime;
                                    video.__bgcObjectUrl = nextUrl;
                                    video.__bgcBlobFor = url;
                                    video.__bgcSourceUrl = url;
                                    video.src = nextUrl;
                                    if (resumeAt > 0.2) {
                                        var restore = function() {
                                            try { video.currentTime = resumeAt; } catch (e) {}
                                            video.play().catch(function() {});
                                        };
                                        video.addEventListener('loadedmetadata', restore, { once: true });
                                    }
                                    video.play().catch(function() {});
                                    if (prevObj) {
                                        try { URL.revokeObjectURL(prevObj); } catch (e) {}
                                    }
                                }).catch(function(e) {
                                    video.__bgcFetchingFor = null;
                                    if (video.__bgcWantedUrl !== url) { return; }
                                    // 直连已经在播就不用管；否则说明两种方式都不行。
                                    if (video.readyState < 2) {
                                        console.error('WallpaperStudio video blob load error:', e);
                                    }
                                });
                            }, delay);
                        };
                        scheduleBlob(switched ? 1200 : 0);
                        return;
                    }

                    let currentSrc = video.src;
                    let newSrc = url;
                    try {
                        if (currentSrc !== newSrc && decodeURIComponent(currentSrc) !== decodeURIComponent(newSrc)) {
                            // 从 blob 切回直链时，回收旧的 object URL。
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                                video.__bgcObjectUrl = null;
                                video.__bgcSourceUrl = null;
                            }
                            video.src = newSrc;
                        }
                    } catch (e) {
                        if (currentSrc !== newSrc) {
                            if (video.__bgcObjectUrl) {
                                try { URL.revokeObjectURL(video.__bgcObjectUrl); } catch (e) {}
                                video.__bgcObjectUrl = null;
                                video.__bgcSourceUrl = null;
                            }
                            video.src = newSrc;
                        }
                    }

                    if (video.paused) {
                        video.play().catch(e => {
                            if (e.name !== 'AbortError') {
                                console.error('WallpaperStudio video play error:', e);
                            }
                        });
                    }
                } catch (e) {
                    console.error('[WallpaperStudio] applyVideo error:', e);
                }
            }
        `;

        return `
        (function() {
            const runtime = {
                timers: [],
                listeners: [],
                observers: [],
                originalOpen: null,
                dispose: function() {
                    this.timers.forEach(id => clearTimeout(id));
                    this.timers = [];
                    this.listeners.forEach(item => {
                        try {
                            item.target.removeEventListener(item.type, item.handler, item.options);
                        } catch (e) {
                            // ignore teardown failures
                        }
                    });
                    this.listeners = [];
                    this.observers.forEach(observer => {
                        try {
                            observer.disconnect();
                        } catch (e) {
                            // ignore teardown failures
                        }
                    });
                    this.observers = [];
                    if (this.originalOpen && window.open !== this.originalOpen) {
                        window.open = this.originalOpen;
                    }
                    this.originalOpen = null;
                    try {
                    } catch (e) {
                        // ignore teardown failures
                    }
                    // Keep the currently rendered scene alive while the dynamic
                    // loader is replaced. The new loader will reuse it when the
                    // CSS still points to the same scene, or dispose it after a
                    // genuinely different background configuration is loaded.
                    // Destroying it here causes a black frame during extension
                    // activation even though the previous background is valid.
                    const assistant = document.getElementById('wallpaper-studio-assistant');
                    if (assistant) {
                        assistant.remove();
                    }
                    const assistantStyle = document.getElementById('wallpaper-studio-assistant-style');
                    if (assistantStyle) {
                        assistantStyle.remove();
                    }
                }
            };
            window.__wallpaperStudioDynamicLoader = runtime;

            function registerTimer(id) {
                runtime.timers.push(id);
                return id;
            }

            function registerInterval(id) {
                runtime.timers.push(id);
                return id;
            }

            function registerListener(target, type, handler, options) {
                target.addEventListener(type, handler, options);
                runtime.listeners.push({ target, type, handler, options });
            }

            function registerObserver(observer) {
                runtime.observers.push(observer);
                return observer;
            }

            const cssDesktopUrl = '${escapedDesktopUrl}';
            const relativeCssPath = '${webCssPath}';
            const cssFileName = '${cssFileName}';
            const workbenchJsName = '${workbenchJsName}';
            const relativePlaceholder = '${relativePlaceholder}';
            const perWindowEnabled = ${perWindowBackground};

            function ensureTrailingSlash(value) {
                if (!value) {
                    return '';
                }
                return value.endsWith('/') ? value : value + '/';
            }

            function getCssBaseHref(url) {
                if (!url) {
                    return '';
                }
                let clean = url;
                const hashIndex = clean.indexOf('#');
                if (hashIndex !== -1) {
                    clean = clean.substring(0, hashIndex);
                }
                const queryIndex = clean.indexOf('?');
                if (queryIndex !== -1) {
                    clean = clean.substring(0, queryIndex);
                }
                const slashIndex = clean.lastIndexOf('/');
                if (slashIndex === -1) {
                    return ensureTrailingSlash(clean);
                }
                return ensureTrailingSlash(clean.substring(0, slashIndex + 1));
            }

            function replaceRelativeTokens(value, baseHref) {
                if (!value || value.indexOf(relativePlaceholder) === -1) {
                    return value;
                }
                return value.split(relativePlaceholder).join(baseHref);
            }

            function deriveFromScript() {
                if (typeof document === 'undefined') {
                    return undefined;
                }

                const buildFromSrc = (src) => {
                    try {
                        return new URL(cssFileName, src).toString();
                    } catch (error) {
                        console.error('[WallpaperStudio] Script URL resolve error:', error);
                        return undefined;
                    }
                };

                const current = document.currentScript;
                if (current && current.src) {
                    const candidate = buildFromSrc(current.src);
                    if (candidate) {
                        return candidate;
                    }
                }

                const scripts = document.getElementsByTagName ? document.getElementsByTagName('script') : [];
                for (let i = scripts.length - 1; i >= 0; i--) {
                    const tag = scripts[i];
                    if (tag && tag.src && tag.src.indexOf(workbenchJsName) !== -1) {
                        const candidate = buildFromSrc(tag.src);
                        if (candidate) {
                            return candidate;
                        }
                    }
                }

                return undefined;
            }

            const resolveCssUrl = () => {
                const scriptResolved = deriveFromScript();
                if (scriptResolved) {
                    return scriptResolved;
                }

                const relativePath = relativeCssPath;
                if (relativePath) {
                    const bases = [];
                    const monacoEnv = typeof globalThis !== 'undefined' ? globalThis.MonacoEnvironment || {} : {};
                    if (monacoEnv.baseUrl) {
                        bases.push(monacoEnv.baseUrl);
                    }
                    if (monacoEnv.appOrigin) {
                        bases.push(monacoEnv.appOrigin);
                    }
                    if (typeof document !== 'undefined' && document.baseURI) {
                        bases.push(document.baseURI);
                    }
                    if (typeof window !== 'undefined' && window.location) {
                        const { origin, href } = window.location;
                        if (origin) {
                            bases.push(origin + '/');
                        }
                        if (href) {
                            const slashIndex = href.lastIndexOf('/');
                            if (slashIndex !== -1) {
                                bases.push(href.substring(0, slashIndex + 1));
                            }
                        }
                    }

                    for (const base of bases) {
                        try {
                            return new URL(relativePath, base).toString();
                        } catch (error) {
                            console.error('[WallpaperStudio] Base URL failed:', error);
                        }
                    }

                    if (!relativePath.startsWith('http')) {
                        try {
                            return new URL(relativePath, '/').toString();
                        } catch (error) {
                            console.error('[WallpaperStudio] Relative URL failed:', error);
                        }
                    }
                }

                return cssDesktopUrl;
            };
            const cssUrl = resolveCssUrl();
            const cssBaseHref = getCssBaseHref(cssUrl);
            const initialCssToken = 'bootstrap';

            function cssUrlForToken(token) {
                // 'shared' = 共用模式：回到不带 session 后缀的共享 CSS。
                if (!token || token === '${sharedCssToken}') return cssUrl;
                if (token === 'bootstrap') {
                    return cssUrl.replace(cssFileName, '${bootstrapCssFileName}');
                }
                const windowFile = cssFileName.replace(/\\.css$/, '.' + token + '.css');
                if (cssUrl.indexOf(cssFileName) !== -1) {
                    return cssUrl.split(cssFileName).join(windowFile);
                }
                return cssUrl;
            }

            // 从"每窗口独立"切到"共用"时，window 上可能还留着上一模式指向 per-window
            // 文件的地址，而那个文件已经不再更新了。动态脚本每次重载都按当前模式复位。
            if (!perWindowEnabled) {
                try {
                    window.__wallpaperStudioCssUrl = undefined;
                } catch (e) {
                    console.error('[WallpaperStudio] Reset css url failed:', e);
                }
            }

            function activeCssUrl() {
                if (window.__wallpaperStudioCssUrl) {
                    return window.__wallpaperStudioCssUrl;
                }
                // In per-window mode, never flash the shared CSS from another
                // window while the current session CSS is being prepared.
                return perWindowEnabled ? cssUrlForToken(initialCssToken) : cssUrl;
            }

            ${videoSetup}
            ${SCENE_CONTINUITY_JS}

            /**
             * 场景页地址。
             *
             * resources=native 必不可少：引擎默认把「贴图」按 devicePixelRatio/2 降采样
             * （见 webwallgl 的 resourceScaleFor），普通屏幕 dpr=1 时只有 0.6 倍 ——
             * 依赖大图层的场景会明显发虚。画布本身（图片输出）是原生分辨率，
             * 所以"预览清晰、背景模糊"其实是贴图被压了。
             */
            const sceneRendererUrl = (() => {
                const url = new URL('./wallpaper-studio-scene.html', import.meta.url);
                url.searchParams.set('resources', 'native');
                url.searchParams.set('runtime', 'continuity-20261107');
                return url.toString();
            })();

            function disposeScene(targetWindow, removeFrame) {
                const state = targetWindow && targetWindow.__wallpaperStudioSceneState;
                if (!state) return;
                state.generation++;
                if (state.fetchController) { state.fetchController.abort(); state.fetchController = null; }
                if (state.frame && state.frame.contentWindow) {
                    try {
                        state.frame.contentWindow.postMessage({ type: 'dispose', token: state.token }, '*');
                    } catch (error) {
                        console.warn('[WallpaperStudio] Scene dispose message failed:', error);
                    }
                }
                state.loading = false;
                state.ready = false;
                state.url = '';
                state.config = null;
                if (removeFrame) {
                    clearWallpaperPoster(targetWindow);
                    detachScenePointer(targetWindow, state);
                    if (state.messageHandler) {
                        targetWindow.removeEventListener('message', state.messageHandler);
                    }
                    if (state.frame) state.frame.remove();
                    targetWindow.__wallpaperStudioSceneState = undefined;
                }
            }

            /**
             * 场景 iframe 自己收不到鼠标事件（它 pointer-events:none，否则会挡住 VS Code 的
             * 所有点击），所以指针由宿主窗口转交：这里把 clientX/Y 归一化成 [0,1] 后
             * postMessage 进去，由 iframe 内脚本调 WebWallGL 的 pushPointer。
             * 归一化原点在左上、Y 轴朝下，与 WebWallGL 的约定一致。
             */
            function attachScenePointer(targetWindow, state) {
                if (state.pointerHandler) return;
                const listeners = [];
                for (const type of ['mousemove', 'pointermove', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
                    targetWindow.addEventListener(type, pointerHandler, { passive: true });
                    listeners.push(type);
                }
                // 鼠标移出窗口不会触发 window 的 mouseleave，得挂在 documentElement 上。
                const root = targetWindow.document && targetWindow.document.documentElement;
                if (root) {
                    root.addEventListener('mouseleave', pointerHandler, { passive: true });
                    root.addEventListener('pointerleave', pointerHandler, { passive: true });
                    listeners.push('mouseleave', 'pointerleave');
                }
                targetWindow.addEventListener('blur', pointerHandler);
                listeners.push('blur');
                state.pointerHandler = pointerHandler;
                state.pointerListenerTypes = listeners;

                /** 修饰键按 WebWallGL 的约定打包：1=shift 2=ctrl 4=alt 8=meta。 */
                function modsOf(event) {
                    return (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
                        (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
                }

                function pointerHandler(event) {
                    if (targetWindow.__wallpaperStudioSceneState !== state) return;
                    if (event.type === 'mouseleave' || event.type === 'pointerleave' || event.type === 'blur') {
                        queueScenePointer(targetWindow, state, { leave: true });
                        return;
                    }
                    if (!state.frame) return;
                    const rect = state.frame.getBoundingClientRect();
                    if (!rect.width || !rect.height) return;
                    const u = (event.clientX - rect.left) / rect.width;
                    const v = (event.clientY - rect.top) / rect.height;
                    // 不要求 ready：场景第一帧出来之前把指针位置先记下来，
                    // 这样视差/鼠标跟随类壁纸一上屏就是正确角度，不会先跳一下。
                    queueScenePointer(targetWindow, state, {
                        u: Math.min(1, Math.max(0, u)),
                        v: Math.min(1, Math.max(0, v)),
                        buttons: event.buttons || 0,
                        mods: modsOf(event)
                    });
                }
            }

            function detachScenePointer(targetWindow, state) {
                const handler = state.pointerHandler;
                if (!handler) return;
                const root = targetWindow.document && targetWindow.document.documentElement;
                for (const type of state.pointerListenerTypes || []) {
                    const target = (type === 'mouseleave' && root) ? root : targetWindow;
                    try {
                        target.removeEventListener(type, handler);
                    } catch (error) {
                        // 窗口可能已经在关闭，忽略。
                    }
                }
                state.pointerHandler = undefined;
                state.pointerListenerTypes = undefined;
                state.pointerPending = undefined;
            }

            /** 指针事件按帧合并：一次 rAF 最多往 iframe 发一条消息。 */
            function queueScenePointer(targetWindow, state, payload) {
                state.pointerPending = payload;
                if (state.pointerRafId) return;
                state.pointerRafId = targetWindow.requestAnimationFrame(function() {
                    state.pointerRafId = undefined;
                    const pending = state.pointerPending;
                    state.pointerPending = undefined;
                    const frame = state.frame;
                    if (!pending || !frame || !frame.contentWindow) return;
                    try {
                        frame.contentWindow.postMessage({ type: 'pointer', pointer: pending }, '*');
                    } catch (error) {
                        // iframe 正在销毁，忽略。
                    }                });
            }

            function loadScenePackage(targetWindow, state) {
                if (!state.rendererReady || state.loading || !state.config) return;
                state.loading = true;
                const generation = state.generation;
                const token = state.token;
                const startedAt = performance.now();
                const controller = new AbortController();
                state.fetchController = controller;
                // Allow Electron to reuse the local package cache across
                // workbench reloads instead of rereading the entire .pkg.
                readWallpaperBytes(targetWindow, state.config.url, controller.signal).then(function(buffer) {
                    if (targetWindow.__wallpaperStudioSceneState !== state || state.generation !== generation) return;
                    recordWallpaperTiming(targetWindow, 'package-fetch', performance.now() - startedAt);
                    state.sentIdentity = wallpaperSceneIdentity(state.config);
                    // postMessage 走结构化克隆：这里的内容虽然来自 JSON.parse，
                    // 但仍做一次深拷贝，彻底排除被其他代码塞进的不可克隆值。
                    var project = state.config.project;
                    try { project = project ? JSON.parse(JSON.stringify(project)) : undefined; } catch (e) { project = undefined; }
                    var properties = state.config.properties || {};
                    try { properties = JSON.parse(JSON.stringify(properties)); } catch (e) { properties = {}; }
                    try {
                        state.frame.contentWindow.postMessage({
                            type: 'load',
                            token: token,
                            bytes: buffer,
                            key: state.config.url,
                            title: state.config.title,
                            project: project,
                            properties: properties,
                            targetFps: state.config.targetFps,
                            maxFps: state.config.maxFps
                        }, '*', [buffer]);
                    } catch (error) {
                        state.loading = false;
                        console.error('[WallpaperStudio] Scene load message failed:', error);
                    }
                }).catch(function(error) {
                    if (targetWindow.__wallpaperStudioSceneState === state && state.generation === generation) {
                        notifyWallpaperRender(targetWindow, state.config, 'error', error.message);
                        state.loading = false;
                        console.error('[WallpaperStudio] Scene package load failed:', error);
                    }
                });
            }

            function applyScene(targetWindow, config) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.body) return;
                    if (!config) {
                        disposeScene(targetWindow, true);
                        return;
                    }

                    let state = targetWindow.__wallpaperStudioSceneState;
                    if (!state || !state.frame || !state.frame.isConnected) {
                        const frame = doc.createElement('iframe');
                        frame.id = 'wallpaper-studio-scene';
                        frame.title = config.title || 'Wallpaper Engine scene';
                        frame.setAttribute('sandbox', 'allow-scripts');
                        frame.style.position = 'fixed';
                        frame.style.inset = '0';
                        frame.style.width = '100%';
                        frame.style.height = '100%';
                        frame.style.border = '0';
                        frame.style.overflow = 'hidden';
                        frame.style.zIndex = '2';
                        frame.style.pointerEvents = 'none';
                        state = {
                            frame: frame,
                            generation: 0,
                            url: '',
                            token: '',
                            config: null,
                            loading: false,
                            ready: false,
                            rendererReady: false,
                            messageHandler: undefined,
                            pointerHandler: undefined,
                            pointerListenerTypes: undefined,
                            pointerPending: undefined,
                            pointerRafId: undefined
                        };
                        state.messageHandler = function(event) {
                            if (event.source !== frame.contentWindow || !event.data) return;
                            const message = event.data;
                            if (message.type === 'renderer-ready') {
                                state.rendererReady = true;
                                loadScenePackage(targetWindow, state);
                                return;
                            }
                            if (message.token !== state.token) return;
                            if (message.type === 'scene-ready') {
                                notifyWallpaperRender(targetWindow, state.config, 'ready');
                                state.loading = false;
                                state.ready = true;
                                clearWallpaperPoster(targetWindow);
                                if (state.sentIdentity === wallpaperSceneIdentity(state.config)) {
                                    saveWallpaperPoster(targetWindow, activeCssUrl(), state.config, message.poster);
                                }
                                recordWallpaperTiming(targetWindow, 'scene-mount', Number(message.mountMs) || 0);
                                recordWallpaperTiming(targetWindow, 'renderer-switch-ready', performance.now() - state.requestedAt);
                                frame.contentWindow.postMessage({ type: 'set-properties', properties: state.config.properties || {}, targetFps: state.config.targetFps, maxFps: state.config.maxFps }, '*');
                            } else if (message.type === 'scene-error') {
                                notifyWallpaperRender(targetWindow, state.config, 'error', message.message);
                                state.loading = false;
                                state.ready = false;
                                console.error('[WallpaperStudio] Scene render failed:', message.message);
                            }
                        };
                        targetWindow.__wallpaperStudioSceneState = state;
                        targetWindow.addEventListener('message', state.messageHandler);
                        attachScenePointer(targetWindow, state);
                        frame.src = sceneRendererUrl;
                        doc.body.prepend(frame);
                        showWallpaperPoster(targetWindow, activeCssUrl(), config);
                    }

                    state.frame.title = config.title || 'Wallpaper Engine scene';
                    state.frame.style.opacity = String(config.opacity);
                    state.frame.style.filter = 'blur(' + config.blur + 'px)';
                    state.frame.style.mixBlendMode = config.blendMode;
                    if (state.url === config.url && (state.loading || state.ready)) {
                        // 记住最新配置，后续 applyToAll（窗口增删/主题切换）要用新值重建。
                        state.config = config;
                        if (state.ready && state.frame && state.frame.contentWindow) {
                            notifyWallpaperRender(targetWindow, config, 'ready');
                            state.frame.contentWindow.postMessage({
                                type: 'set-properties',
                                properties: config.properties || {},
                                targetFps: config.targetFps,
                                maxFps: config.maxFps
                            }, '*');
                        }
                        return;
                    }

                    // Keep the current scene until new bytes arrive.
                    // The isolated renderer covers its old frame before replacing the single GPU scene.
                    if (state.fetchController) { state.fetchController.abort(); }
                    state.generation++;
                    state.loading = false;
                    state.ready = false;
                    state.requestedAt = performance.now();
                    state.url = config.url;
                    state.config = config;
                    state.token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
                    loadScenePackage(targetWindow, state);
                } catch (error) {
                    console.error('[WallpaperStudio] applyScene error:', error);
                }
            }

            // A6: 换图淡入淡出片段（background-image 不可过渡，用 opacity 模拟交叉淡化）
            ${IMAGE_FADE_JS}

            function applyStyle(targetWindow, css) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.head) return;
                    let style = doc.getElementById('wallpaper-studio-style');
                    if (!style) {
                        style = doc.createElement('style');
                        style.id = 'wallpaper-studio-style';
                        doc.head.appendChild(style);
                    }
                    // A6: 换图交叉淡化（cross-fade 图片级混合，body::before 规则全程不变）
                    bgcApplyStyleWithFade(targetWindow, style, css);
                } catch (e) {
                    console.error('[WallpaperStudio] applyStyle error:', e);
                }
            }

            // Track auxiliary windows opened by VSCode (e.g. the new AgentView "Open Agents Window",
            // floating editor windows, etc.). Each auxiliary window is a separate Electron BrowserWindow
            // with its own document/body, so we must mirror the <style> and <video> into each.
            // The set lives on window so it survives dynamic-script reloads; otherwise windows
            // captured by a previous generation would stop receiving background updates.
            if (!window.__wallpaperStudioAuxWindows) {
                window.__wallpaperStudioAuxWindows = new Set();
            }
            const auxWindows = window.__wallpaperStudioAuxWindows;
            let lastCss = '';
            let lastVideoConfig = null;
            let lastSceneConfig = null;

            function isWindowAlive(w) {
                try {
                    return !!(w && !w.closed && w.document);
                } catch (e) {
                    return false;
                }
            }

            function applyToWindow(w) {
                if (!isWindowAlive(w)) return;
                try {
                    if (window.__wallpaperStudioCssUrl) {
                        w.__wallpaperStudioCssUrl = window.__wallpaperStudioCssUrl;
                    }
                } catch (e) {
                    // Auxiliary windows may not allow property writes during init.
                }
                applyStyle(w, lastCss);
                applyVideo(w, lastVideoConfig);
                applyScene(w, lastSceneConfig);
            }

            function applyToAll() {
                applyToWindow(window);
                auxWindows.forEach(w => {
                    if (isWindowAlive(w)) {
                        applyToWindow(w);
                    } else {
                        auxWindows.delete(w);
                    }
                });
            }

            function registerAuxWindow(newWindow) {
                if (!newWindow || newWindow === window) return;
                if (auxWindows.has(newWindow)) return;
                auxWindows.add(newWindow);

                // VSCode opens auxiliary windows with about:blank then rewrites the document.
                // Apply on a short retry schedule so we catch the post-rewrite head/body.
                let attempts = 0;
                const maxAttempts = 40; // ~20s total
                const tick = () => {
                    attempts++;
                    if (!isWindowAlive(newWindow)) {
                        auxWindows.delete(newWindow);
                        return;
                    }
                    try {
                        applyToWindow(newWindow);
                    } catch (e) {
                        // ignore transient errors during window init
                    }
                    if (attempts < maxAttempts) {
                        registerTimer(setTimeout(tick, 500));
                    }
                };
                tick();

                try {
                    registerListener(newWindow, 'unload', () => {
                        auxWindows.delete(newWindow);
                    }, { once: true });
                } catch (e) {
                    // ignore
                }
            }

            // Hook window.open so we capture every auxiliary window VSCode opens.
            try {
                const originalOpen = window.open || null;
                if (originalOpen) {
                    runtime.originalOpen = originalOpen;
                    window.open = function() {
                        const result = originalOpen.apply(window, arguments);
                        try {
                            if (result && result !== window) {
                                registerAuxWindow(result);
                            }
                        } catch (e) {
                            console.error('[WallpaperStudio] window.open hook error:', e);
                        }
                        return result;
                    };
                }
            } catch (e) {
                console.error('[WallpaperStudio] window.open patch error:', e);
            }

            // A5: 图片预加载片段（换图前预热，消除首帧闪烁）
            ${PRELOAD_IMAGE_JS}

            let cssLoadInFlight = false;
            let cssReloadPending = false;
            let lastCssLoadAt = 0;
            let forceCssReload = false;

            function withCacheBust(url) {
                const sep = url.indexOf('?') === -1 ? '?' : '&';
                return url + sep + 't=' + Date.now();
            }

            /**
             * 配置块写盘时为了模板字符串安全会把反引号和 \${ 转义，直接 JSON.parse 会失败。
             * 这里先按原样解析，失败再用字符码还原一次，避免一次配置失败就整段失效。
             */
            function parseConfigText(text) {
                try { return JSON.parse(text); } catch (e) { /* try unescaped */ }
                var tick = String.fromCharCode(96);
                var slash = String.fromCharCode(92);
                var unescaped = text.split(slash + tick).join(tick);
                unescaped = unescaped.split(slash + '$' + '{').join('$' + '{');
                try { return JSON.parse(unescaped); } catch (e) { return null; }
            }

            function loadCss(forceFresh) {
                // 拖动滑块时会有连续的变更通知：正在读的时候不能直接丢弃，
                // 否则最后一次改动（用户实际停下的位置）可能永远不生效。
                if (cssLoadInFlight) {
                    cssReloadPending = true;
                    forceCssReload = forceCssReload || !!forceFresh;
                    return;
                }
                cssLoadInFlight = true;
                lastCssLoadAt = Date.now();
                const currentCssUrl = activeCssUrl();
                const url = forceFresh ? withCacheBust(currentCssUrl) : currentCssUrl;
                const hadCss = !!lastCss;
                fetch(url).then(r => {
                    if (!r.ok) throw new Error('Background CSS read failed: ' + r.status);
                    return r.text();
                }).then(css => {
                    const resolvedCss = replaceRelativeTokens(css, getCssBaseHref(currentCssUrl) || cssBaseHref);
                    lastCss = resolvedCss;

                    const match = resolvedCss.match(/\\/\\*wallpaper-studio-video-start\\*\\/([\\s\\S]*?)\\/\\*wallpaper-studio-video-end\\*\\//);
                    if (match) {
                        const config = parseConfigText(match[1]);
                        if (config && typeof config === 'object') {
                            config.url = replaceRelativeTokens(config.url, cssBaseHref);
                            lastVideoConfig = config;
                        } else {
                            console.error('[WallpaperStudio] Video config parse error');
                            lastVideoConfig = null;
                        }
                    } else {
                        lastVideoConfig = null;
                    }

                    const sceneMatch = resolvedCss.match(/\\/\\*wallpaper-studio-scene-start\\*\\/([\\s\\S]*?)\\/\\*wallpaper-studio-scene-end\\*\\//);
                    if (sceneMatch) {
                        const config = parseConfigText(sceneMatch[1]);
                        if (config && typeof config === 'object') {
                            config.url = replaceRelativeTokens(config.url, cssBaseHref);
                            lastSceneConfig = config;
                        } else {
                            console.error('[WallpaperStudio] Scene config parse error');
                            lastSceneConfig = null;
                        }
                    } else {
                        lastSceneConfig = null;
                    }

                    // The first background has no old layer to cross-fade from.
                    // Do not make the initial render wait for the preload timeout.
                    return hadCss ? preloadBackgroundImage(resolvedCss) : undefined;
                }).then(() => {
                    applyToAll();
                }).catch(e => console.error('[WallpaperStudio] Load error:', e))
                .finally(() => {
                    cssLoadInFlight = false;
                    if (cssReloadPending) {
                        cssReloadPending = false;
                        const nextForceFresh = forceCssReload;
                        forceCssReload = false;
                        loadCss(nextForceFresh);
                    }
                });
            }

            function scheduleLoadCss(reason, delay, forceFresh) {
                registerTimer(setTimeout(() => {
                    try {
                        loadCss(!!forceFresh);
                    } catch (e) {
                        console.error('[WallpaperStudio] Scheduled load error (' + reason + '):', e);
                    }
                }, delay || 0));
            }

            // Initial load
            scheduleLoadCss('initial', 0, false);

            // 1. Event Hook: Listen for status bar message
            try {
                const observer = registerObserver(new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        const target = mutation.target;
                        // Check text content of the mutated node
                        if (target.textContent && target.textContent.includes('wallpaper-studio-reload-trigger')) {
                            // ':js:' means the dynamic bundle itself changed and must be
                            // re-imported; a CSS-only change just refreshes the stylesheet
                            // so the injected runtime keeps its state.
                            const triggerMatch = target.textContent.match(/wallpaper-studio-reload-trigger:(css|js):\\d+:([0-9a-z]+)/i);
                            if (triggerMatch && triggerMatch[2]) {
                                window.__wallpaperStudioCssUrl = cssUrlForToken(triggerMatch[2]);
                            }
                            const wantsJsReload = target.textContent.includes('wallpaper-studio-reload-trigger:js:');
                            const bootstrap = window.__wallpaperStudioBootstrap;
                            if (wantsJsReload && bootstrap && typeof bootstrap.reload === 'function') {
                                bootstrap.reload();
                            } else {
                                scheduleLoadCss('statusbar', 0, true);
                                scheduleLoadCss('statusbar-followup', 600);
                            }
                            return;
                        }
                    }
                }));

                const findStatusBar = () => {
                    // Try to find the status bar container
                    const statusBar = document.querySelector('.statusbar') || document.getElementById('workbench.parts.statusbar') || document.querySelector('footer');
                    if (statusBar) {
                        observer.observe(statusBar, {
                            subtree: true,
                            characterData: true,
                            childList: true
                        });
                        console.log('[WallpaperStudio] Observer attached to:', statusBar);
                    } else {
                        // Retry if not found yet
                        registerTimer(setTimeout(findStatusBar, 2000));
                    }
                };

                if (document.readyState === 'loading') {
                    registerListener(document, 'DOMContentLoaded', findStatusBar);
                } else {
                    findStatusBar();
                }
            } catch (e) {
                console.error('[WallpaperStudio] Observer error:', e);
            }

            // 2. Backup Hook: Check on window focus
            // This ensures that if the status bar trigger is missed, the background updates when the user interacts with the window
            registerListener(window, 'focus', () => {
                if (Date.now() - lastCssLoadAt > 800) {
                    scheduleLoadCss('focus', 0);
                }
            });
            registerListener(document, 'visibilitychange', () => {
                if (!document.hidden) {
                    scheduleLoadCss('visibility', 0);
                }
            });
            registerListener(document, 'pointerdown', () => {
                if (Date.now() - lastCssLoadAt > 1500) {
                    scheduleLoadCss('pointer', 0);
                }
            }, { passive: true });

            let startupPolls = 0;
            const startupPoll = registerInterval(setInterval(() => {
                startupPolls++;
                scheduleLoadCss('startup-poll', 0);
                if (startupPolls >= 6) {
                    clearInterval(startupPoll);
                }
            }, 2000));

        })();
        `;
    }

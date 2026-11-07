import { reactive } from 'vue';
import { useBridge } from './useBridge';
import { getThumbnail, setThumbnail } from './useThumbnailCache';
import type { SceneRenderConfig } from '../../../src/sceneRender';

/**
 * Wallpaper Engine 场景包首帧预览。
 *
 * 面板里没法直接渲染场景：`.pkg` 要靠 WebWallGL 跑真渲染，而那份运行时是 1.1 MB，
 * 塞进本来就不小的 webview bundle 不划算。所以复用扩展已经准备好的那份场景页
 * （`globalStorage/scene-preview/wallpaper-studio-scene.html`，由 StudioViewProvider
 * 提供 webview URI），用一个离屏 iframe 当渲染器：
 *
 *   面板 fetch(pkg) → postMessage(bytes, capture:true) → iframe 渲染并回传首帧
 *
 * 关键限制：**不能让 iframe 去导航到那个 webview URI**。`asWebviewUri` 的
 * `https://file+.vscode-resource.vscode-cdn.net/…` 只对面板顶层文档生效，子框架的
 * 请求不被 webview 层接管，会直接漏到真实 DNS（实测 `net::ERR_NAME_NOT_RESOLVED`）；
 * `vscode-file:` 与 `blob:` 又分别被 CSP / 宿主层拒绝。因此这里把页面内容取回来，
 * 用 `srcdoc` 交给 iframe —— srcdoc 会继承父页 CSP，所以内联脚本必须补上面的 nonce，
 * 面板 CSP 也必须放开场景运行时需要的 `unsafe-eval` / `blob:`（见 StudioViewProvider）。
 *
 * 同一时刻只有一个 iframe、一次只渲染一个包（串行队列），出帧后立刻 dispose 场景
 * 释放 GPU；结果按 pkg 的 webview URI 缓存，多处同时展示同一个包也只渲染一次。
 */

const SCENE_FRAME_WIDTH = 640;
const SCENE_FRAME_HEIGHT = 360;
/** 场景页加载（含 WebWallGL 初始化）的上限。1.5MB 页面 + 1.1MB 运行时解码不可控，给足余量。 */
const PAGE_READY_TIMEOUT_MS = 20000;
/** 单个场景从投递到出帧的上限；超时视为失败，避免拖住后面的排队项。 */
const FRAME_TIMEOUT_MS = 40000;
/** 同一个包最多尝试几次（失败可能只是那一刻 GPU 忙），避免失败后无限重试。 */
const MAX_ATTEMPTS = 3;
/** 渲染器握手重试间隔。 */
const READY_PING_MS = 400;
/** 预览页地址询问的重试间隔与上限。 */
const PAGE_URI_RETRY_MS = 2000;
const PAGE_URI_MAX_REQUESTS = 6;

/** pkg 的 webview URI → 首帧 dataURL */
const cache = reactive<Record<string, string>>({});
/** pkg 的 webview URI → 正在渲染（驱动 UI 显示加载态） */
const rendering = reactive<Record<string, boolean>>({});
/** pkg 的 webview URI → 最近一次失败原因（透传到 UI，出问题时有据可查） */
const errors = reactive<Record<string, string>>({});

const attempts = new Map<string, number>();
const inflight = new Map<string, Promise<string | null>>();

interface PreviewJob {
    key: string;
    cacheKey: string;
    priority: boolean;
    controller: AbortController;
    cancelled: boolean;
    properties?: Record<string, unknown>;
    project?: unknown;
    resolve: (outcome: RenderOutcome) => void;
}
const queue: PreviewJob[] = [];
let queueRunning = false;
let activeJob: PreviewJob | null = null;
let frameGeneration = 0;

let pageUri = '';
let pageNonce = '';
let pageHtml = '';
let pageRequested = false;
let pageAttempts = 0;
let pageError = '';
let pageWaiters: Array<() => void> = [];

let frame: HTMLIFrameElement | null = null;
let frameReadyPromise: Promise<void> | null = null;
let resolveFrameReady: (() => void) | null = null;
/** 当前 iframe 里的渲染器是否已握手成功。 */
let ready = false;

let currentToken = '';
let currentResolve: ((dataUrl: string | null) => void) | null = null;
let currentTimer = 0;
/** 本轮渲染的失败原因（渲染器回报或宿主侧判定）。 */
let currentError = '';

function nextToken(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
        const timer = window.setTimeout(() => resolve(fallback), ms);
        void promise.then(value => {
            window.clearTimeout(timer);
            resolve(value);
        });
    });
}

/**
 * 等渲染器握手。场景页启动时会主动发一次 `renderer-ready`，但那是一次性消息：
 * 它可能在宿主挂上监听器之前就发出去（1.5MB 页面 + 1.1MB 运行时解码的时序不可控），
 * 消息丢了就永远等不到。所以这里周期性补发 `ping`，渲染器无条件应答。
 *
 * 返回空串表示就绪，否则是失败原因。
 */
async function waitForRenderer(signal: AbortSignal): Promise<string> {
    const el = await ensureFrame(signal);
    if (!el || !el.contentWindow) {
        return pageError
            ? `扩展未能准备场景预览页：${pageError}`
            : '扩展未提供场景预览页地址（scenePreviewPage 应答为空）';
    }
    if (ready) { return ''; }
    const target = el.contentWindow;
    const readiness = frameReadyPromise;
    if (!readiness) { return '预览 iframe 未初始化'; }
    return new Promise<string>(resolve => {
        const sendPing = () => {
            try { target.postMessage({ type: 'ping' }, '*'); } catch { /* iframe 已销毁 */ }
        };
        const ping = window.setInterval(sendPing, READY_PING_MS);
        sendPing();
        void withTimeout(readiness, PAGE_READY_TIMEOUT_MS, undefined).then(() => {
            window.clearInterval(ping);
            resolve(ready ? '' : '场景渲染器未就绪（场景页加载或 WebGL 初始化超时）');
        });
    });
}

/**
 * 场景页加载失败/超时后 iframe 内部状态不可信，直接重建。下一次请求会拿到
 * 一个全新的页面，它必然会重新发一遍 renderer-ready。
 */
function recycleFrame() {
    releaseFrame();
}

/** 向扩展要预览页地址；多个调用共享同一次应答。 */
function requestPageUri(): Promise<string> {
    if (pageUri) { return Promise.resolve(pageUri); }
    const bridge = useBridge();
    return new Promise<string>(resolve => {
        pageWaiters.push(() => resolve(pageUri));
        if (pageRequested) { return; }
        pageRequested = true;
        bridge.on('scenePreviewPage', (data: any) => {
            const uri = typeof data?.uri === 'string' ? data.uri : '';
            pageUri = uri;
            if (typeof data?.nonce === 'string') { pageNonce = data.nonce; }
            if (!uri && typeof data?.error === 'string') { pageError = data.error; }
            if (data?.regenerated === true) {
                // The URI is stable, but the generated HTML may contain a new
                // WebWallGL bundle or scene script.
                pageHtml = '';
                releaseFrame();
            }
            const waiters = pageWaiters;
            pageWaiters = [];
            waiters.forEach(fn => fn());
            if (!uri) {
                // Allow a later preview request to ask the extension again
                // after a transient generation or resource-root failure.
                pageRequested = false;
                pageAttempts = 0;
            }
        });
        // 应答也可能丢（面板刚挂载就发问，扩展还没把应答路由回来）。重问是幂等的：
        // 扩展侧有 ensured 缓存和 stamp 比对，重复请求不会重复生成 1.5MB 页面。
        bridge.post({ type: 'scenePreviewPage' });
        const retry = window.setInterval(() => {
            if (!pageWaiters.length) { window.clearInterval(retry); return; }
            if (pageAttempts >= PAGE_URI_MAX_REQUESTS) {
                window.clearInterval(retry);
                pageRequested = false;
                pageAttempts = 0;
                pageError = pageError || '扩展未能在限定时间内准备场景预览页';
                const waiters = pageWaiters;
                pageWaiters = [];
                waiters.forEach(fn => fn());
                return;
            }
            pageAttempts++;
            bridge.post({ type: 'scenePreviewPage' });
        }, PAGE_URI_RETRY_MS);
    });
}

function onFrameMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow || !event.data) { return; }
    const message = event.data;
    if (message.type === 'renderer-ready') {
        ready = true;
        resolveFrameReady?.();
        resolveFrameReady = null;
        return;
    }
    if (!currentResolve || message.token !== currentToken) { return; }
    if (message.type === 'scene-frame') {
        finish(typeof message.dataUrl === 'string' ? message.dataUrl : null);
    } else if (message.type === 'scene-error' || message.type === 'scene-frame-error') {
        // 渲染器给的失败原因必须留住，否则面板只能干巴巴地说"失败了"。
        currentError = typeof message.message === 'string' && message.message
            ? message.message
            : (typeof message.error === 'string' ? message.error : '');
        finish(null);
    }
}

function finish(dataUrl: string | null) {
    const resolve = currentResolve;
    currentResolve = null;
    if (currentTimer) {
        window.clearTimeout(currentTimer);
        currentTimer = 0;
    }
    resolve?.(dataUrl);
}

/**
 * 取回场景页内容，给内联脚本补上面板的 nonce。
 *
 * srcdoc 子框架会继承父页 CSP（父页用 nonce 收口内联脚本），不补 nonce 的话页面里
 * 那两个 `run()` 动态脚本会被拦掉，渲染器根本起不来。
 *
 * 按模板里的 `data-wallpaper-studio-scene` 标记定位，而不是匹配标签名：面板 bundle
 * 里只要出现字面量标签名，就会被扩展侧的 nonce 注入逻辑改坏（实测会把整个 bundle
 * 变成 `Invalid regular expression flags` 语法错误）。
 */
const SCENE_SCRIPT_MARKER = 'data-wallpaper-studio-scene';

async function loadPageHtml(uri: string): Promise<string> {
    if (pageHtml) { return pageHtml; }
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`读取场景预览页失败（HTTP ${response.status}）`);
    }
    const html = await response.text();
    pageHtml = pageNonce && html.includes(SCENE_SCRIPT_MARKER)
        ? html.replace(SCENE_SCRIPT_MARKER, `${SCENE_SCRIPT_MARKER} nonce="${pageNonce}"`)
        : html;
    return pageHtml;
}

async function ensureFrame(signal: AbortSignal): Promise<HTMLIFrameElement | null> {
    const uri = await requestPageUri();
    if (!uri || signal.aborted) { return null; }
    const generation = frameGeneration;
    if (frame) { return frame; }
    let html = '';
    try {
        html = await loadPageHtml(uri);
    } catch (error) {
        pageError = error instanceof Error ? error.message : String(error);
        return null;
    }
    if (signal.aborted || generation !== frameGeneration) { return null; }
    const el = document.createElement('iframe');
    el.setAttribute('sandbox', 'allow-scripts');
    el.setAttribute('aria-hidden', 'true');
    el.title = 'Wallpaper Engine scene preview';
    // 必须留在视口内：视口之外的 iframe 浏览器不再派发 rAF，WebWallGL 产不出首帧。
    // 因此用 opacity:0 让它彻底看不见（实测该方式下渲染正常），而不是挪到屏幕外。
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = SCENE_FRAME_WIDTH + 'px';
    el.style.height = SCENE_FRAME_HEIGHT + 'px';
    el.style.opacity = '0';
    el.style.border = '0';
    el.style.pointerEvents = 'none';
    frameReadyPromise = new Promise<void>(resolve => { resolveFrameReady = resolve; });
    ready = false;
    window.addEventListener('message', onFrameMessage);
    // 用 srcdoc 而不是 src：子框架导航不到 webview URI，原因见文件头注释。
    el.srcdoc = html;
    frame = el;
    document.body.appendChild(el);
    return el;
}

interface RenderOutcome { dataUrl: string | null; error: string; }

/**
 * 转成「结构化克隆」可接受的数据。
 *
 * `postMessage` 用结构化克隆算法，它不接受 Proxy。面板里的配置来自 Vue 的
 * `reactive()`，`config.imageProject` / `config.imageProperties` 取出来是 Proxy，
 * 直接放进消息会抛 `DataCloneError: #<Object> could not be cloned`。
 * 这里的数据本来就是纯 JSON，深拷贝一次既拆掉 Proxy，也顺带剔除函数与 DOM 引用。
 */
function toCloneable<T>(value: T | undefined): T | undefined {
    if (value === undefined || value === null) { return undefined; }
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return undefined;
    }
}

async function renderOnce(
    job: PreviewJob
): Promise<RenderOutcome> {
    const { key, properties, project } = job;
    currentError = '';
    // 先握手再投递：渲染器没就绪就 postMessage，等于把字节丢进一个还没挂监听器的
    // 窗口，等再久也等不到首帧。握手失败直接重建 iframe，让下一次尝试干净重来。
    let abortReady: (() => void) | undefined;
    const aborted = new Promise<string>(resolve => {
        abortReady = () => resolve('cancelled');
        job.controller.signal.addEventListener('abort', abortReady, { once: true });
    });
    const readyError = await Promise.race([waitForRenderer(job.controller.signal), aborted]);
    if (abortReady) { job.controller.signal.removeEventListener('abort', abortReady); }
    if (job.cancelled) { return { dataUrl: null, error: '' }; }
    if (readyError) {
        recycleFrame();
        return { dataUrl: null, error: readyError };
    }
    const el = frame;
    if (!el || !el.contentWindow) {
        recycleFrame();
        return { dataUrl: null, error: '预览 iframe 不可用' };
    }
    let handedOff = false;
    try {
        // pkg 已经是扩展侧登记过的 webview URI（display 字段就是 asWebviewUri 产物），直接取原始字节。
        const response = await fetch(key, { signal: job.controller.signal });
        if (!response.ok) {
            return { dataUrl: null, error: `读取场景包失败（HTTP ${response.status}）` };
        }
        const buffer = await response.arrayBuffer();
        if (job.cancelled) { return { dataUrl: null, error: '' }; }
        const token = nextToken();
        currentToken = token;
        const result = new Promise<string | null>(resolve => { currentResolve = resolve; });
        currentTimer = window.setTimeout(() => {
            currentError = '场景渲染超时（渲染器未在限定时间内产出首帧）';
            finish(null);
        }, FRAME_TIMEOUT_MS);
        /**
         * 首帧必须带上当前用户配置（含 XY 视角）与项目声明，否则预览和实际渲染不一样。
         * 万一仍然遇到不可克隆的值（第三方数据里混进函数/Proxy），退一步只发字节，
         * 让预览至少能出来，而不是整块报错。
         */
        const send = (withData: boolean): void => {
            const message: Record<string, unknown> = {
                type: 'load',
                token,
                bytes: buffer,
                key,
                title: '',
                capture: true
            };
            if (withData) {
                message.properties = toCloneable(properties) || {};
                message.project = toCloneable(project);
            }
            el.contentWindow!.postMessage(message, '*', [buffer]);
        };
        try {
            send(true);
        } catch (error) {
            if (!(error instanceof Error) || error.name !== 'DataCloneError') { throw error; }
            console.warn('[WallpaperStudio] Scene preview payload was not cloneable, retrying without properties:', error);
            send(false);
        }
        handedOff = true;
        const dataUrl = await result;
        try { el.contentWindow.postMessage({ type: 'dispose', token }, '*'); } catch { /* iframe 已销毁 */ }
        if (dataUrl) { return { dataUrl, error: '' }; }
        return { dataUrl: null, error: currentError || '渲染器未返回画面' };
    } catch (error) {
        return { dataUrl: null, error: job.cancelled ? '' : error instanceof Error ? error.message : String(error) };
    } finally {
        // 握手成功但连投递都没走完（例如 fetch 抛错），说明 iframe 本身也不可靠了。
        if (!handedOff) { recycleFrame(); }
    }
}

function runQueue() {
    if (queueRunning) { return; }
    queueRunning = true;
    void (async () => {
        try {
            while (queue.length) {
                const job = queue.shift()!;
                if (job.cancelled) { continue; }
                activeJob = job;
                job.resolve(await renderOnce(job).catch(error => ({ dataUrl: null,
                    error: job.cancelled ? '' : error instanceof Error ? error.message : String(error) })));
                if (activeJob === job) { activeJob = null; }
            }
        } finally {
            activeJob = null;
            queueRunning = false;
        }
    })();
}

/** 属性集合 → 稳定的短哈希，用于把「同一场景包 + 不同配置」区分成不同缓存项。 */
function propertiesKey(properties?: Record<string, unknown>): string {
    if (!properties) { return ''; }
    const keys = Object.keys(properties).sort();
    if (!keys.length) { return ''; }
    let hash = 5381;
    for (const key of keys) {
        const text = key + '\u0000' + String(properties[key]) + '\u0001';
        for (let i = 0; i < text.length; i += 1) {
            hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
        }
    }
    return '#' + hash.toString(36);
}

/**
 * 场景包首帧的双层缓存。
 *
 * - **精确键** `scene:<url>#<属性哈希>`：当前配置下真正渲染出来的画面；
 * - **基线键** `scene:<url>`：该场景包任意一次渲染的结果。
 *
 * 为什么要两层：首页带当前用户配置渲染，列表页只想要「有个图」。如果两者各自
 * 用不同的键，同一个包会被渲染两次、缓存两份 —— 列表滚动时就会一直排队渲染，
 * 表现就是"打开好久了还在加载"。有了基线，列表直接复用首页/上次的帧。
 */
function lookup(key: string, properties?: Record<string, unknown>): { exact: string; base: string } {
    const cacheKey = key + propertiesKey(properties);
    const exact = cache[cacheKey] || getThumbnail(`scene:${cacheKey}`);
    if (exact) { cache[cacheKey] = exact; }
    const base = cache[key] || getThumbnail(`scene:${key}`);
    if (base) { cache[key] = base; }
    return { exact, base };
}

function requestPreview(
    key: string,
    priority = false,
    renderConfig?: Pick<SceneRenderConfig, 'properties' | 'project'>
): Promise<string | null> {
    if (!key) { return Promise.resolve(null); }
    const properties = renderConfig?.properties;
    const project = renderConfig?.project;
    const cacheKey = key + propertiesKey(properties);
    if (priority) { cancelJobs(job => job.cacheKey !== cacheKey && (job.priority || job === activeJob)); }
    const { exact, base } = lookup(key, properties);
    if (exact) { return Promise.resolve(exact); }

    const existing = inflight.get(cacheKey);
    if (existing) { return existing; }

    // 已有基线：立刻返回一张能看的图，别让 UI 空着等渲染。
    // 首页（priority）另外在后台升级成"当前配置"的精确帧，不阻塞返回。
    if (base) {
        if (!priority) { return Promise.resolve(base); }
        if ((attempts.get(cacheKey) ?? 0) < MAX_ATTEMPTS) {
            void enqueue(key, cacheKey, priority, properties, project);
        }
        return Promise.resolve(base);
    }

    if ((attempts.get(cacheKey) ?? 0) >= MAX_ATTEMPTS) { return Promise.resolve(null); }
    return enqueue(key, cacheKey, priority, properties, project);
}

function enqueue(
    key: string,
    cacheKey: string,
    priority: boolean,
    properties?: Record<string, unknown>,
    project?: unknown
): Promise<string | null> {
    let job: PreviewJob;
    const task = new Promise<RenderOutcome>(resolve => {
        rendering[cacheKey] = true;
        attempts.set(cacheKey, (attempts.get(cacheKey) ?? 0) + 1);
        job = { key, cacheKey, priority, controller: new AbortController(), cancelled: false,
            properties: toCloneable(properties), project: toCloneable(project), resolve };
        if (priority) {
            queue.unshift(job);
        } else {
            queue.push(job);
        }
        runQueue();
    }).then(({ dataUrl, error }) => {
        if (job.cancelled) { return null; }
        if (dataUrl) {
            cache[cacheKey] = dataUrl;
            setThumbnail(`scene:${cacheKey}`, dataUrl);
            // 第一次渲染成功时顺便记一份基线，供列表/下次打开直接复用。
            if (!cache[key]) {
                cache[key] = dataUrl;
                setThumbnail(`scene:${key}`, dataUrl);
            }
            delete errors[cacheKey];
        } else if (error) {
            errors[cacheKey] = error;
        }
        if (inflight.get(cacheKey) === task) {
            rendering[cacheKey] = false;
            inflight.delete(cacheKey);
        }
        return dataUrl;
    });
    inflight.set(cacheKey, task);
    return task;
}

/** 释放离屏 iframe（回收 WebGL 上下文）；下次请求会重建。 */
function releaseFrame() {
    frameGeneration++;
    resolveFrameReady?.();
    if (!frame) { return; }
    window.removeEventListener('message', onFrameMessage);
    finish(null);
    frame.remove();
    frame = null;
    frameReadyPromise = null;
    resolveFrameReady = null;
    ready = false;
}

function cancelJobs(predicate: (job: PreviewJob) => boolean) {
    const cancel = (job: PreviewJob) => {
        if (job.cancelled || !predicate(job)) { return false; }
        job.cancelled = true;
        job.controller.abort();
        inflight.delete(job.cacheKey);
        attempts.set(job.cacheKey, Math.max(0, (attempts.get(job.cacheKey) || 1) - 1));
        rendering[job.cacheKey] = false;
        job.resolve({ dataUrl: null, error: '' });
        return true;
    };
    for (let i = queue.length - 1; i >= 0; i--) {
        if (cancel(queue[i])) { queue.splice(i, 1); }
    }
    if (activeJob && cancel(activeJob)) { releaseFrame(); }
}

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { cancelJobs(() => true); }
    });
}

export function useScenePreview() {
    return {
        /** 已渲染好的首帧；未渲染返回空串。精确键未命中时退回该包的基线帧。 */
        previewOf(key: string, properties?: Record<string, unknown>): string {
            if (!key) { return ''; }
            const { exact, base } = lookup(key, properties);
            return exact || base;
        },
        /** 是否正在渲染该场景包。 */
        isRendering(key: string, properties?: Record<string, unknown>): boolean {
            return !!rendering[key + propertiesKey(properties)];
        },
        /** 最近一次渲染失败的原因；没有失败过返回空串。 */
        lastError(key: string, properties?: Record<string, unknown>): string {
            return errors[key + propertiesKey(properties)] || '';
        },
        /**
         * 请求首帧。已缓存直接返回；同一路径正在渲染则复用同一个 Promise。
         * 渲染失败返回 null（同一个包最多尝试 MAX_ATTEMPTS 次）。
         */
        requestPreview,
        cancelPriority() { cancelJobs(job => job.priority); },
        cancelQueuedExcept(keys: Set<string>) { cancelJobs(job => !job.priority && !keys.has(job.key)); },
        /** 丢弃缓存（例如用户重新选择了同名文件）。 */
        invalidate(key?: string) {
            const keys = key ? [key] : Object.keys(cache);
            keys.forEach(k => {
                delete cache[k];
                delete errors[k];
                attempts.delete(k);
            });
        },
        releaseFrame
    };
}

/** webview 卸载时清掉模块级单例，避免残留旧 iframe 和缓存。 */
export function disposeScenePreviewRuntime() {
    cancelJobs(() => true);
    releaseFrame();
    Object.keys(cache).forEach(k => delete cache[k]);
    Object.keys(errors).forEach(k => delete errors[k]);
    attempts.clear();
    pageHtml = '';
    pageRequested = false;
    pageAttempts = 0;
    const waiters = pageWaiters;
    pageWaiters = [];
    waiters.forEach(resolve => resolve());
}

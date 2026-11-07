import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    CancellationToken,
    ExtensionContext,
    Uri,
    Webview,
    commands,
    env,
    workspace,
    window,
    Disposable
} from 'vscode';
import { PickList } from './PickList';
import { onDidChangeGlobalState } from './global';
import { ensureWorkspaceRecord, resolveCurrentBlur, resolveCurrentImagePath, resolveCurrentOpacity } from './windowBackground';
import { expandPathVariables } from './pathUtil';
import { ensureWallpaperScenePreviewPage } from './scenePreview';
import {
    DEFAULT_WALLPAPER_CONFIG,
    WallpaperEntry,
    WallpaperProperty,
    hasWallpaperConfig,
    readRemovedWallpapers,
    getWallpaperProjectProperties,
    getWallpaperProjectDeclaration,
    removeWallpaper,
    readWallpaperPlaylistAsync,
    rememberWallpaperPlaylist,
    forgetWallpaperPlaylist,
    getWallpaperPropertyOverrides,
    setWallpaperProperty,
    setWallpaperProperties
} from './wallpaperEngine';
import { clearWallpaperProjectCache, WALLPAPER_USER_KEY } from './wallpaperEngine';
import { resolveActiveWallpaperUser } from './wallpaperEngine';
import { isWallpaperPkgPath } from './wallpaperPkg';
import {
    DEFAULT_SOURCE_MODE,
    SourceMode,
    getCandidatesForMode,
    getRandomCandidates,
    normalizeSourceMode,
    setSourceMode
} from './sourceMode';
import { ThumbnailStore } from './thumbnailStore';
import { getAppConfig, onDidChangeSettings, resetSettings } from './settingsStore';
import { isWebviewMessage, WebviewMessage } from './webviewProtocol';
import { createSceneRenderConfig } from './sceneRender';
import { resolveBlendModeValue } from './backgroundCss';
import { isPathInsideFolder, normalizeComparablePath } from './pathComparison';
import { clearRuntimeState } from './runtimeStore';

const PUSH_DEBOUNCE_MS = 120;
/** 播放列表加载进度的合并间隔：既能看清计数在走，又不会把消息队列刷满。 */
const WALLPAPER_PROGRESS_INTERVAL_MS = 40;


/** globalState keys the webview may write directly via `setGlobalState`. */
const WEBVIEW_WRITABLE_STATE_KEYS = new Set<string>(['wallpaperStudioLocale']);

/**
 * Vue-powered single-pane configuration webview.
 *
 * Loads the inlined Vite build at `webview-dist/index.html`, injects a CSP
 * + nonce, and brokers messages between the extension host and the SPA.
 *
 * Inbound message shapes:
 *   { type: 'ready' }
 *   { type: 'runAction', action: number, path?: string }
 *   { type: 'setConfig', key: string, value: any }
 *   { type: 'setGlobalState', key: string, value: any }
 *   { type: 'openExternal', url: string }
  *   { type: 'scenePreviewPage' }
 *
 * Outbound:
 *   { type: 'state', data: { locale, config, state } }
 *   { type: 'navigate', tab: 'home'|'local'|'advanced' }
 *   { type: 'scenePreviewPage', uri: string, regenerated?: boolean, error?: string }
 */
export class StudioViewProvider implements WebviewViewProvider {

    public static readonly viewType = 'wallpaperStudio.studio';

    /** 构建产物（约 500KB）进程内缓存，避免每次打开面板都读盘。 */
    private static indexHtmlCache = '';
    private static indexHtmlPath = '';

    private view?: WebviewView;
    private disposables: Disposable[] = [];
    /** Nonce baked into the current webview HTML; the scene preview frame needs it too. */
    private webviewNonce = '';
    /** Set of allowed local-resource root directories (fs paths). */
    private allowedRoots = new Set<string>();
    private pushTimer?: ReturnType<typeof setTimeout>;
    /** Folder listing cache keyed by folder path + mtime; avoids readdir on every push. */
    private folderCache?: { folder: string; mtimeMs: number; names: string[] };
    private wallpaperConfigPath = DEFAULT_WALLPAPER_CONFIG;
    private wallpaperConfigEnabled = false;
    private sourceMode: 'file' | 'folder' | 'wallpaper' = 'file';
    private wallpaperEntries: WallpaperEntry[] = [];
    /** 上次读取的壁纸引擎用户节点；变了就说明换了账号，必须整份重读。 */
    private wallpaperUser = '';
    /** 壁纸播放列表为空的提示文案（仅 wallpaper 模式推送）。 */
    private wallpaperNotice = '';
    /** 已经弹过的提示文案，避免每次 pushState 都重复弹 toast。 */
    private notifiedWallpaperNotice = '';
    /** 播放列表已触发读取但尚未完成时的进度。 */
    private wallpaperLoading = false;
    private wallpaperLoaded = 0;
    private wallpaperTotal = 0;
    /** 是否已经有过一次「读完了」的播放列表结果（首次加载期间必须一直显示加载态）。 */
    private wallpaperLoadedOnce = false;
    /** 进度消息按帧合并用的定时器。 */
    private wallpaperProgressTimer?: ReturnType<typeof setTimeout>;
    /** 合并面板恢复和列表打开时对同一份播放列表的并发读取。 */
    private wallpaperSyncPromise?: Promise<void>;
    private wallpaperSyncKey = '';
    /** 已完成的读取结果；文件签名、用户或移除名单变化时自动失效。 */
    private wallpaperCompletedKey = '';
    private wallpaperSyncGeneration = 0;
    /** 图库页按需加载；首页首屏不发送大量列表数据。 */
    private galleryRequested = false;
    /** 上次推送给面板的背景路径，用来判断"是否换壁纸了"，从而跳过防抖立刻推送。 */
    private lastPushedImagePath = '';
    /** 缩略图持久化（跨 VS Code 重启复用，避免重新渲染首帧）。 */
    private readonly thumbnails: ThumbnailStore;
    /** 面板上报的缩略图写入合并成一次落盘，避免拖动时反复写文件。 */
    private thumbnailWriteTimer?: ReturnType<typeof setTimeout>;
    private readonly pendingThumbnails = new Map<string, string>();

    constructor(private readonly ctx: ExtensionContext) {
        // globalStorageUri 在真实环境一定存在；单测里的 mock context 可能没有，
        // 退化到临时目录，避免构造阶段直接抛错。
        const storageRoot = this.ctx.globalStorageUri?.fsPath
            || path.join(os.tmpdir(), 'wallpaper-studio-storage');
        this.thumbnails = new ThumbnailStore(storageRoot);
        this.wallpaperConfigPath = this.ctx.globalState.get<string>(
            'wallpaperStudioWallpaperConfig',
            DEFAULT_WALLPAPER_CONFIG
        );
        this.wallpaperConfigEnabled = this.ctx.globalState.get<boolean>('wallpaperStudioWallpaperEnabled', true);
        // 默认使用 Wallpaper Engine 播放列表；用户切到其他模式后才记住其他值。
        this.sourceMode = this.ctx.globalState.get<'file' | 'folder' | 'wallpaper'>(
            'wallpaperStudioSourceMode',
            'wallpaper'
        );
        // 默认模式的一次性迁移；预热由扩展激活处调用 prewarm()（避免重复执行）。
        void this.applyDefaultModeOnce();
    }

    /**
     * 启动时把面板需要的状态预先准备好。
     *
     * VS Code 的视图只有在用户点开时才 `resolveWebviewView`，所以真正的 HTML 与
     * JS 只能那时加载。这里只预热缩略图索引，不含图片数据。
     * 播放列表在首次进入列表页时按需读取，完成后按配置签名复用。
     */
    public async prewarm(): Promise<void> {
        try {
            this.thumbnails.warm();
            // Gallery data is loaded when the gallery tab is requested. Keep
            // extension activation focused on restoring the live background.
        } catch (error) {
            console.warn('[WallpaperStudio] Prewarm skipped:', error);
        }
    }

    /**
     * 一次性把默认来源模式切换为「Wallpaper 配置」。
     *
     * 老版本把默认写成 file，并且这个值已经落进 globalState，光改代码里的默认值
     * 不会生效。这里清掉那两个键（让新的默认值生效）后打一个标记，只做一次，
     * 之后用户在 UI 里的选择依然会被记住。
     */
    private async applyDefaultModeOnce(): Promise<void> {
        const key = 'wallpaperStudioDefaultModeWallpaper';
        if (this.ctx.globalState.get<boolean>(key, false)) { return; }
        await this.ctx.globalState.update('wallpaperStudioSourceMode', undefined);
        await this.ctx.globalState.update('wallpaperStudioWallpaperEnabled', undefined);
        await this.ctx.globalState.update(key, true);
        this.wallpaperConfigEnabled = true;
        this.sourceMode = 'wallpaper';
    }


    public resolveWebviewView(
        view: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ): void {
        this.view = view;
        this.seedAllowedRoots();
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: this.computeRootUris()
        };
        view.webview.html = this.getHtml(view.webview);
        this.wallpaperConfigPath = this.ctx.globalState.get<string>('wallpaperStudioWallpaperConfig', DEFAULT_WALLPAPER_CONFIG);

        // 首页只同步当前设置；列表由 loadGallery 按需读取。
        this.pushState();
        void this.pushThumbnails();

        view.webview.onDidReceiveMessage((msg: unknown) => {
            void this.handleMessage(msg).catch(error => {
                this.toast(error instanceof Error ? error.message : String(error), 'error');
                this.pushState();
            });
        }, undefined, this.disposables);


        // Push state on config / globalState changes

        
        // 配置/globalState 的变化往往是成串的（拖滑块、自动换图 tick），合并成一次推送。
        this.disposables.push(onDidChangeSettings(changed => {
            if (changed.length && changed.every(key => key === 'opacity' || key === 'blur')) { this.pushAppearanceState(); }
            else { this.schedulePush(); }
        }));
        this.disposables.push(onDidChangeGlobalState.event(() => this.schedulePush()));

        view.onDidDispose(() => {
            if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; }
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
            this.view = undefined;
        });
    }

    private schedulePush(): void {
        if (!this.view) { return; }
        if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; }
        // 换壁纸（手动点列表、随机、自动轮播）必须立刻刷新首页预览与配置面板，
        // 否则用户会看到「背景已经变了但界面还是上一张」。其余变化（拖滑块等）
        // 仍然合并，避免高频推送。
        const current = resolveCurrentImagePath(
            getAppConfig().get<string>('imagePath') || ''
        );
        if (current !== this.lastPushedImagePath) {
            this.pushState();
            return;
        }
        this.pushTimer = setTimeout(() => {
            this.pushTimer = undefined;
            this.pushState();
        }, PUSH_DEBOUNCE_MS);
    }

    /** List folder media, reusing the previous listing while the directory mtime is unchanged. */
    private listFolder(folder: string): string[] {
        const mtimeMs = fs.statSync(folder).mtimeMs;
        const c = this.folderCache;
        if (c && c.folder === folder && c.mtimeMs === mtimeMs) {
            return c.names;
        }
        const names = PickList.listFolderImages(folder);
        this.folderCache = { folder, mtimeMs, names };
        return names;
    }

    /** Re-send full state; used by external commands (refresh/home/support). */
    private pushAppearanceState(): void {
        if (!this.view) { return; }
        const cfg = getAppConfig();
        void this.view.webview.postMessage({ type: 'state', data: { config: {
            opacity: resolveCurrentOpacity(cfg.get('opacity') ?? 0),
            blur: resolveCurrentBlur(cfg.get('blur') ?? 0)
        } } });
    }

    public pushState(includeGallery = true): void {
        if (!this.view) { return; }
        if (this.pushTimer) { clearTimeout(this.pushTimer); this.pushTimer = undefined; }
        const cfg = getAppConfig();
        const gs = this.ctx.globalState;

        const imagePath = resolveCurrentImagePath(cfg.get<string>('imagePath') || '');
        this.lastPushedImagePath = imagePath;
        const imagePathDisplay = this.toWebviewUri(imagePath);
        const wallpaperMode = this.wallpaperConfigEnabled && hasWallpaperConfig(this.wallpaperConfigPath);
        const imagePathLabel = wallpaperMode
            ? (this.wallpaperEntries.find(entry => entry.path === imagePath)?.title || this.basename(imagePath))
            : '';
        // 当前背景的完整 Wallpaper Engine 配置项：三种来源共用同一份解析结果，
        // 不再依赖首页去列表里按路径反查（路径归一化不一致时会查不到）。
        const imageProperties = this.withViewProperties(
            getWallpaperProjectProperties(imagePath).map(property => ({
                ...property,
                value: getWallpaperPropertyOverrides(gs, imagePath)[property.key] ?? property.value
            })),
            imagePath
        );
        const imageProject = getWallpaperProjectDeclaration(imagePath);
        const wallpaperPaths = new Set(this.wallpaperEntries.map(entry => normalizeComparablePath(entry.path)));
        const recentStored = gs.get<string[]>('wallpaperStudioRecentImages', []) || [];
        const currentFolder = expandPathVariables(cfg.get<string>('randomImageFolder') || '');
        const recentRaw = this.sourceMode === 'wallpaper'
            ? recentStored.filter(item => wallpaperPaths.has(normalizeComparablePath(item)))
            : this.sourceMode === 'folder'
                ? recentStored.filter(item => currentFolder && this.isPathInFolder(item, currentFolder))
                : recentStored.filter(item => !wallpaperPaths.has(normalizeComparablePath(item)));
        const recentImages = includeGallery && this.galleryRequested ? recentRaw.map(p => ({
            path: p,
            display: this.toWebviewUri(p),
            name: this.basename(p),
            properties: getWallpaperProjectProperties(p).map(property => ({
                ...property,
                value: getWallpaperPropertyOverrides(gs, p)[property.key] ?? property.value
            }))
        })) : [];

        const folder = expandPathVariables(cfg.get<string>('randomImageFolder') || '');
        const removedFolderImages = new Set(gs.get<string[]>('wallpaperStudioFolderRemoved', []) || []);
        let folderImages: { path: string; display: string; name: string }[] = [];
        let folderImagesTotal = 0;
        try {
            if (includeGallery && this.galleryRequested && !wallpaperMode && folder && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) {
                const names = this.listFolder(folder);
                folderImagesTotal = names.length;
                folderImages = names.slice(0, 2000).map(name => {
                    const full = path.join(folder, name);
                    return {
                        path: full,
                        display: this.toWebviewUri(full),
                        name,
                        // 目录里可能有上千个文件：这里不再逐个解析 project.json。
                        // 当前壁纸的完整配置由 `config.imageProperties` 单独推送，
                        // 每次换壁纸都同步 2000 个项目的属性会明显卡顿。
                        properties: []
                    };
                }).filter(item => !removedFolderImages.has(item.path));
            }

        } catch {
            folderImages = [];
            folderImagesTotal = 0;
        }

        let brandLogo = '';
        try {
            const logoUri = Uri.joinPath(this.ctx.extensionUri, 'resources', 'wallpaper-studio.png');
            brandLogo = this.view.webview.asWebviewUri(logoUri).toString();
        } catch { brandLogo = ''; }
        const pkg = (this.ctx.extension && (this.ctx.extension as any).packageJSON) || {};
        const brandName: string = pkg.displayName || pkg.name || 'wallpaper-studio';

        const message = {
            type: 'state',
            data: {
                // 默认中文：用户在面板里切换过语言才用其选择。
                locale: (gs.get<string>('wallpaperStudioLocale') as 'en' | 'zh' | undefined) ?? 'zh',
                brandLogo,
                brandName,
                config: {
                    // 透明度/模糊度按窗口+工作区独立存储，推送当前窗口实际生效的值，
                    // 不同工作区窗口的 webview 会显示各自不同的数值。
                    opacity: resolveCurrentOpacity(cfg.get('opacity') ?? 0),
                    blur: resolveCurrentBlur(cfg.get('blur') ?? 0),
                    imagePath,
                    imagePathDisplay,
                    imagePathLabel,
                    imageProperties,
                    imageProject,
                    sceneRender: imagePath && isWallpaperPkgPath(imagePath)
                        ? createSceneRenderConfig({
                            url: imagePathDisplay,
                            title: imagePathLabel || this.basename(imagePath),
                            project: imageProject,
                            properties: Object.fromEntries(imageProperties.map(property => [property.key, property.value])),
                            opacity: resolveCurrentOpacity(cfg.get('opacity') ?? 0),
                            blur: resolveCurrentBlur(cfg.get('blur') ?? 0),
                            blendMode: resolveBlendModeValue(cfg.get('blendModel') ?? 'auto')
                        })
                        : undefined,
                    autoStatus: cfg.get('autoStatus') ?? false,
                    autoInterval: cfg.get('autoInterval') ?? 0,
                    sizeModel: cfg.get('sizeModel') ?? 'cover',
                    blendModel: cfg.get('blendModel') ?? 'auto',
                    randomImageFolder: cfg.get('randomImageFolder') ?? '',
                    perWindowBackground: cfg.get('perWindowBackground') ?? true,
                    backgroundTransition: true
                },
                state: {
                    sourceMode: wallpaperMode ? 'wallpaper' : this.sourceMode,
                    recentImages,
                    folderImages,
                    folderImagesTotal,
                    wallpaperConfigEnabled: wallpaperMode,
                    wallpaperConfigPath: this.wallpaperConfigPath,
                    // 播放列表为空的原因（只在 wallpaper 模式有意义）。
                    wallpaperNotice: wallpaperMode ? this.wallpaperNotice : '',
                    // 加载态不能挂在 wallpaperMode 上：配置刚切换/读取中时它会短暂为 false，
                    // 面板就会把「正在加载」误判成「没有壁纸」。
                    // 首次加载还没出结果时也必须算加载中：否则解析开始前那几帧会推
                    // 一条「loading=false + 空列表」的状态，面板闪一下「没有壁纸」。
                    // 首次读盘还没出结果时也必须算加载中：否则解析开始前那几帧会推
                    // 一条「loading=false + 空列表」的状态，面板闪一下「没有壁纸」。
                    wallpaperLoading: this.wallpaperLoading
                        || (!this.wallpaperLoadedOnce && this.currentSourceMode() === 'wallpaper'),
                    // 面板据此区分「还没读过」和「读到了但真的没有壁纸」，
                    // 首次读盘期间一律显示加载态，不会闪一下「没有壁纸」。
                    wallpaperLoadedOnce: this.wallpaperLoadedOnce,
                    wallpaperLoaded: this.wallpaperLoaded,
                    wallpaperTotal: this.wallpaperTotal,
                    // 首页不需要完整播放列表。只在用户打开图库后构造 URI、属性和媒体信息，
                    // 避免首屏把几百个项目交给 Webview 的 Vue 响应式系统。
                    wallpaperPlaylist: includeGallery && this.galleryRequested ? this.wallpaperEntries.map(entry => ({
                        ...entry,
                        preview: entry.preview ? this.toWebviewUri(entry.preview) : '',
                        mediaSource: this.toWebviewUri(entry.path),
                        sceneSource: entry.sceneSource ? this.toWebviewUri(entry.sceneSource) : '',
                        properties: entry.properties.map(property => ({
                            ...property,
                            value: getWallpaperPropertyOverrides(gs, entry.path)[property.key] ?? property.value
                        }))
                    })) : []
                }
            }
        };
        if (!includeGallery) {
            const summary: Record<string, unknown> = message.data.state;
            for (const key of ['recentImages', 'folderImages', 'folderImagesTotal', 'wallpaperPlaylist']) { delete summary[key]; }
        }
        void this.view.webview.postMessage(message);
    }

    /**
     * 推送播放列表加载进度。
     *
     * 必须是**节流**而不是防抖：解析循环每一项都会调用一次，如果每次都把待发的
     * 定时器清掉重排，连续调用永远等不到那 40ms，面板就会一直停在 0/总数，
     * 直到结束时才突然跳到总数。
     */
    private pushWallpaperLoadingProgress(force = false): void {
        if (!this.view) { return; }
        const post = () => {
            this.wallpaperProgressTimer = undefined;
            void this.view?.webview.postMessage({
                type: 'wallpaper-loading',
                loading: this.wallpaperLoading,
                loaded: this.wallpaperLoaded,
                total: this.wallpaperTotal
            });
        };
        if (force) {
            if (this.wallpaperProgressTimer) {
                clearTimeout(this.wallpaperProgressTimer);
                this.wallpaperProgressTimer = undefined;
            }
            post();
            return;
        }
        // 已有待发的定时器就不要动它：等它到点把最新的计数发出去。
        if (this.wallpaperProgressTimer) { return; }
        this.wallpaperProgressTimer = setTimeout(post, WALLPAPER_PROGRESS_INTERVAL_MS);
    }

    /** 把扩展侧保存的缩略图推给面板（面板重新打开时直接复用，不重新渲染）。 */
    private async pushThumbnails(): Promise<void> {
        if (!this.view) { return; }
        try {
            const data = await this.thumbnails.snapshot();
            if (!this.view || !Object.keys(data).length) { return; }
            void this.view.webview.postMessage({ type: 'thumbnails', data });
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to push thumbnails:', error);
        }
    }

    /** 合并写入：面板滚动/批量渲染时会连续上报很多张。 */
    private queueThumbnailWrite(key: string, value: string): void {
        this.pendingThumbnails.set(key, value);
        if (this.thumbnailWriteTimer) { clearTimeout(this.thumbnailWriteTimer); }
        this.thumbnailWriteTimer = setTimeout(() => {
            this.thumbnailWriteTimer = undefined;
            const batch = Array.from(this.pendingThumbnails);
            this.pendingThumbnails.clear();
            void this.thumbnails.setMany(batch).catch(error =>
                console.warn('[WallpaperStudio] Thumbnail batch failed:', error));
        }, 800);
    }

    /**
     * 在系统文件资源管理器中定位壁纸文件。
     *
     * 直接调用系统自带工具，不依赖 VS Code 内部命令 ——
     * `revealFileAction` / `revealInExplorer` 在不同版本、不同上下文里可能
     * 「不抛错但什么也不做」，之前的实现因此表现为点了没反应。
     *
     * Windows 用 `explorer.exe /select,"<path>"`（注意它正常退出也会返回 1，不能判错），
     * macOS 用 `open -R`，Linux 优先 `dbus-send` 的 FileManager1.ShowItems，
     * 失败时退回打开所在目录。
     */
    private async revealInExplorer(target: string): Promise<void> {
        const resolved = path.normalize(target);
        if (!fs.existsSync(resolved)) {
            this.toast(`文件不存在，无法打开所在位置：${resolved}`, 'error');
            return;
        }
        const isDirectory = fs.statSync(resolved).isDirectory();

        if (isDirectory) {
            try {
                await env.openExternal(Uri.file(resolved));
                return;
            } catch (error) {
                console.warn('[WallpaperStudio] Failed to open folder:', error);
            }
        } else {
            try {
                const launched = await this.launchSystemReveal(resolved);
                if (launched) { return; }
            } catch (error) {
                console.warn('[WallpaperStudio] System reveal failed:', error);
            }
        }

        // 最后兜底：打开所在目录，至少能定位到文件旁边。
        try {
            await env.openExternal(Uri.file(path.dirname(resolved)));
            return;
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to open containing folder:', error);
        }
        this.toast(`无法打开所在位置：${resolved}`, 'error');
    }

    /** 平台相关的「在资源管理器中选中文件」。返回 false 表示该平台没有可用手段。 */
    private launchSystemReveal(resolved: string): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            const platform = process.platform;
            let command: string;
            let args: string[];
            if (platform === 'win32') {
                command = 'explorer.exe';
                // explorer 对 /select 的解析要求路径带引号且紧跟逗号。
                args = [`/select,"${resolved}"`];
            } else if (platform === 'darwin') {
                command = 'open';
                args = ['-R', resolved];
            } else {
                command = 'dbus-send';
                args = [
                    '--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
                    '--type=method_call',
                    '/org/freedesktop/FileManager1',
                    'org.freedesktop.FileManager1.ShowItems',
                    `array:string:${Uri.file(resolved).toString()}`,
                    'string:""'
                ];
            }
            try {
                const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: platform === 'win32' });
                let settled = false;
                const done = (value: boolean) => {
                    if (settled) { return; }
                    settled = true;
                    resolve(value);
                };
                child.on('error', () => done(false));
                child.on('exit', code => {
                    // explorer.exe 成功时也返回 1，不能按退出码判断；只要进程起来了就算成功。
                    done(platform === 'win32' ? true : code === 0);
                });
                child.unref();
                // Linux 上 dbus 可能长时间不退出，给个短超时避免卡住调用方。
                setTimeout(() => done(platform !== 'linux'), 1500);
            } catch {
                resolve(false);
            }
        });
    }

    /**
     * 补齐「视角」相关的属性项。
     *
     * 视角值按**壁纸路径**独立保存在 globalState 的覆盖表里，但读取时必须出现在
     * `imageProperties` 里才能被面板识别。没有 `project.json` 的壁纸（视频、图片、
     * 目录媒体）属性列表是空的 —— 那些壁纸调整过视角后，值虽然存下来了，
     * 却因为这里不返回而读不回来，表现为"换了壁纸再换回来，视角丢了"。
     *
     * 所以无论项目有没有属性声明，都把这两个视角项补上（值优先取已保存的覆盖值）。
     */
    private withViewProperties(
        properties: WallpaperProperty[],
        wallpaperPath: string
    ): WallpaperProperty[] {
        if (!wallpaperPath) { return properties; }
        const overrides = getWallpaperPropertyOverrides(this.ctx.globalState, wallpaperPath);
        const result = properties.slice();
        const addIfMissing = (key: string, text: string, fallback: number) => {
            if (result.some(property => property.key === key)) { return; }
            const value = Number(overrides[key]);
            result.push({
                key,
                type: 'slider',
                text,
                value: Number.isFinite(value) ? value : fallback,
                min: 0,
                max: 200,
                step: 1
            });
        };
        // 视角项排在最后，避免插到项目自己的分组之间。
        addIfMissing('wallpaperstudio_pan_x', '水平视角 X', 100);
        addIfMissing('wallpaperstudio_pan_y', '垂直视角 Y', 100);
        return result;
    }

    private isPathInFolder(value: string, folder: string): boolean {
        return isPathInsideFolder(value, folder);
    }

    private normalizePath(value: string): string {
        return normalizeComparablePath(value);
    }

    /** Programmatic navigation hook for `view/title` menu commands. */
    public navigate(tab: 'home' | 'local' | 'advanced'): void {
        this.view?.webview.postMessage({ type: 'navigate', tab });
    }

    /** Refresh the current Studio data without switching to the legacy gallery view. */
    public async refresh(): Promise<void> {
        this.folderCache = undefined;
        await this.syncWallpaperPlaylist(true);
        this.pushState();
    }

    /**
     * 指定模式下的候选壁纸。
     *
     * 直接复用 `sourceMode.getCandidatesForMode()` —— 随机、上一张、模式切换
     * 全部走同一份实现，避免"面板一套、PickList 另一套"导致跨模式串数据。
     */
    private getModeCandidates(mode: SourceMode): string[] {
        return getCandidatesForMode(normalizeSourceMode(mode));
    }

    private async handleMessage(value: unknown): Promise<void> {
        if (!isWebviewMessage(value)) { return; }
        const msg: WebviewMessage = value;
        switch (msg.type) {
            case 'ready':
                this.pushState();
                if (this.galleryRequested && this.sourceMode === 'wallpaper') {
                    await this.syncWallpaperPlaylist();
                    this.pushState();
                    this.notifyWallpaperNotice();
                }
                void this.pushThumbnails();
                return;

            case 'refresh':
                await this.refresh();
                return;

            case 'loadGallery':
                this.galleryRequested = true;
                if (this.sourceMode === 'wallpaper') { await this.syncWallpaperPlaylist(); }
                this.pushState();
                return;

            case 'setSourceMode':
                if (msg.mode === 'file' || msg.mode === 'folder' || msg.mode === 'wallpaper') {
                    const mode = normalizeSourceMode(msg.mode);
                    this.sourceMode = mode;
                    // setSourceMode 会同时同步历史键 wallpaperStudioWallpaperEnabled，
                    // 避免"模式"与"是否启用播放列表"两套判定打架。
                    await setSourceMode(mode);
                    if (mode === 'wallpaper') {
                        this.wallpaperConfigEnabled = true;
                        await this.syncWallpaperPlaylist();
                        // 播放列表空/找不到用户时明确提示，不要停在"什么都没有"。
                        this.notifyWallpaperNotice();
                    } else {
                        this.wallpaperConfigEnabled = false;
                    }
                    // 切模式后只使用新模式自己的候选；没有候选时必须清空旧模式背景，
                    // 避免首页继续显示上一模式的路径和预览。
                    const candidates = this.getModeCandidates(mode);
                    if (candidates.length) {
                        const selected = candidates[Math.floor(Math.random() * candidates.length)];
                        await commands.executeCommand('wallpaperStudio.setConfig', 'wallpaperStudio.imagePath', selected);
                    } else {
                        await commands.executeCommand('wallpaperStudio.runAction', 7);
                    }
                    this.pushState();
                }
                return;

            case 'runAction':
                if (typeof msg.action === 'number') {
                    await commands.executeCommand('wallpaperStudio.runAction', msg.action, msg.path);
                    this.pushState();
                }
                return;

            case 'setConfig':
                if (typeof msg.key === 'string') {
                    await commands.executeCommand('wallpaperStudio.setConfig', `wallpaperStudio.${msg.key}`, msg.value);
                    if (msg.key === 'opacity' || msg.key === 'blur') { this.pushAppearanceState(); }
                    else { this.pushState(); }
                }
                return;

            case 'setGlobalState':
                if (typeof msg.key === 'string' && WEBVIEW_WRITABLE_STATE_KEYS.has(msg.key)) {
                    await this.ctx.globalState.update(msg.key, msg.value);
                    onDidChangeGlobalState.fire();
                }
                return;

            case 'clearRecentImages':
                await this.ctx.globalState.update('wallpaperStudioRecentImages', []);
                this.pushState();
                return;

            case 'selectWallpaperConfig': {
                const selected = await window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    openLabel: 'Select Wallpaper Engine config.json',
                    filters: { 'Wallpaper Engine configuration': ['json'] }
                });
                const filePath = selected?.[0]?.fsPath;
                if (!filePath) { return; }
                this.wallpaperConfigPath = filePath;
                this.wallpaperConfigEnabled = true;
                this.sourceMode = 'wallpaper';
                // 换了 config.json 就可能换了账号，用户缓存必须作废。
                this.wallpaperUser = '';
                await this.ctx.globalState.update('wallpaperStudioWallpaperConfig', filePath);
                await this.ctx.globalState.update('wallpaperStudioWallpaperEnabled', true);
                await this.ctx.globalState.update('wallpaperStudioSourceMode', 'wallpaper');
                await this.ctx.globalState.update('wallpaperStudioWallpaperRemoved', []);
                await getAppConfig().update('randomImageFolder', '', true);
                await this.ctx.globalState.update('wallpaperStudioOnlineFolder', undefined);
                await this.ctx.globalState.update('wallpaperStudioOnlineImageList', undefined);
                await this.syncWallpaperPlaylist();
                this.pushState();
                return;
            }

            case 'reloadWallpaperConfig': {
                // 重新读取当前 config.json：清缓存 → 重新解析 → 重建列表。
                // 只读，不修改 config.json，也不动磁盘上的壁纸文件。
                if (!fs.existsSync(this.wallpaperConfigPath)) {
                    this.toast('找不到 Wallpaper 配置文件，请先选择 config.json', 'error');
                    return;
                }
                await this.syncWallpaperPlaylist(true);
                const total = this.wallpaperEntries.length;
                if (!total) {
                    this.toast(this.wallpaperNotice || '配置里没有可用的壁纸（仅支持场景包与视频）', 'warning');
                } else {
                    this.toast(`已重新读取配置，共 ${total} 张壁纸`, 'info');
                }
                this.pushState();
                return;
            }

            case 'randomWallpaper': {
                // 随机换一张时用来排除当前壁纸，同样要读真正生效的路径。
                const current = resolveCurrentImagePath(
                    getAppConfig().get<string>('imagePath') || ''
                );
                // 只在当前模式内抽，并排除当前这张。
                const pool = getRandomCandidates(current);
                if (!pool.length) {
                    this.toast('当前模式没有可用的壁纸', 'warning');
                    return;
                }
                const next = pool[Math.floor(Math.random() * pool.length)];
                await commands.executeCommand('wallpaperStudio.setConfig', 'wallpaperStudio.imagePath', next);
                this.pushState();
                return;
            }

            case 'previousWallpaper': {
                // 设置里的 imagePath 只在首次选择时写入，之后一律走 globalState 记录，
                // 必须用 resolveCurrentImagePath 才能拿到真正在显示的壁纸。
                const current = resolveCurrentImagePath(
                    getAppConfig().get<string>('imagePath') || ''
                );
                const mode = this.currentSourceMode();
                const history = this.ctx.globalState.get<string[]>('wallpaperStudioRecentImages', []) || [];
                const currentKey = this.normalizePath(current);
                const index = current ? history.findIndex(item => this.normalizePath(item) === currentKey) : -1;
                // 只在「当前壁纸之后」找上一张；历史里越靠前越新。
                const candidates = index >= 0 ? history.slice(index + 1) : history.slice();
                if (!candidates.length) {
                    this.toast('没有上一张壁纸了', 'warning');
                    return;
                }
                // 上一张必须是同一配置模式里「可用」的壁纸；跨模式不允许。
                // 用 isInMode 而不是互斥的 modeOfPath：同一文件既在最近列表、
                // 又在目录里时，两种模式都应该能回退到它。
                const pool = new Set(this.getModeCandidates(mode).map(item => this.normalizePath(item)));
                const next = candidates.find(item => pool.has(this.normalizePath(item)) && fs.existsSync(item));
                if (!next) {
                    this.toast(`不能跨模式切换：上一张来自「${this.modeLabel(this.modeOfPath(candidates[0]))}」`, 'error');
                    return;
                }
                if (this.normalizePath(next) === currentKey) {
                    // 历史里只有这一张（或前后都是它）：静默返回会让用户以为按钮坏了。
                    this.toast('没有更早的壁纸了', 'info');
                    return;
                }
                await commands.executeCommand('wallpaperStudio.setConfig', 'wallpaperStudio.imagePath', next);
                this.pushState();
                return;
            }

            case 'useWallpaper':
                if (typeof msg.path === 'string') {
                    await commands.executeCommand('wallpaperStudio.setConfig', 'wallpaperStudio.imagePath', msg.path);
                    this.pushState();
                }
                return;

            case 'removeWallpaper':
                if (typeof msg.path === 'string') {
                    await removeWallpaper(this.ctx.globalState, msg.path);
                    await this.syncWallpaperPlaylist();
                    this.pushState();
                }
                return;

            case 'removePlaylistItem':
                if (typeof msg.path === 'string') {
                    const target = msg.path;
                    const key = this.normalizePath(target);
                    const recent = this.ctx.globalState.get<string[]>('wallpaperStudioRecentImages', []) || [];
                    // 三种模式都只从「列表 + 轮播池」里移除：要么记进 globalState 的
                    // 已移除清单，要么从最近列表里删掉。绝不修改 Wallpaper 的 config.json，
                    // 也不动磁盘上的壁纸文件。
                    if (msg.mode === 'wallpaper') {
                        await removeWallpaper(this.ctx.globalState, target);
                        await this.syncWallpaperPlaylist();
                    } else if (msg.mode === 'folder') {
                        const removed = this.ctx.globalState.get<string[]>('wallpaperStudioFolderRemoved', []) || [];
                        if (!removed.some(item => this.normalizePath(item) === key)) {
                            await this.ctx.globalState.update('wallpaperStudioFolderRemoved', [...removed, target]);
                        }
                        this.folderCache = undefined;
                    }
                    // 最近播放历史里也去掉，否则「上一张」会把它切回来。
                    if (recent.some(item => this.normalizePath(item) === key)) {
                        await this.ctx.globalState.update(
                            'wallpaperStudioRecentImages',
                            recent.filter(item => this.normalizePath(item) !== key)
                        );
                    }
                    // 移除的正好是当前壁纸：自动切到同模式下仍可用的一张，
                    // 避免界面显示"一个已经不在列表里"的壁纸。
                    const current = resolveCurrentImagePath(
                        getAppConfig().get<string>('imagePath') || ''
                    );
                    if (current && this.normalizePath(current) === key) {
                        const next = this.getModeCandidates(this.currentSourceMode())[0] || '';
                        await commands.executeCommand('wallpaperStudio.setConfig', 'wallpaperStudio.imagePath', next);
                    }
                    this.pushState();
                }
                return;

            case 'cacheThumbnail':
                if (typeof msg.key === 'string' && typeof msg.value === 'string') {
                    this.queueThumbnailWrite(msg.key, msg.value);
                }
                return;

            case 'revealInExplorer':
                if (typeof msg.path === 'string' && msg.path) {
                    await this.revealInExplorer(msg.path);
                }
                return;

            case 'setWallpaperProperty':
                if (typeof msg.path === 'string' && typeof msg.key === 'string') {
                    await setWallpaperProperty(this.ctx.globalState, msg.path, msg.key, msg.value);
                    this.scheduleWallpaperPropertyApply(msg.path);
                }
                return;

            case 'setWallpaperProperties':
                if (typeof msg.path === 'string' && msg.properties && typeof msg.properties === 'object') {
                    await setWallpaperProperties(this.ctx.globalState, msg.path, msg.properties);
                    this.scheduleWallpaperPropertyApply(msg.path);
                }
                return;

            case 'resetAll':
                await this.resetAllState();
                return;

            case 'openExternal':
                if (typeof msg.url === 'string' && /^https:\/\//i.test(msg.url)) {
                    await env.openExternal(Uri.parse(msg.url));
                }
                return;

            case 'scenePreviewPage':
                await this.sendScenePreviewPage();
                return;
        }
    }

    private wallpaperPropertyApplyTimer?: ReturnType<typeof setTimeout>;
    /** 正在应用的属性写入（避免并发重装背景）。 */
    private wallpaperPropertyApplying = false;
    /** 应用期间又来了新值，结束后需要再跑一轮。 */
    private wallpaperPropertyDirty = false;
    private wallpaperPropertyPath = '';

    /**
     * 调整壁纸用户配置 / XY 视角后立刻生效。
     *
     * 连续拖动滑块时消息会很密集，这里做三件事：
     *  1. 60ms 合并，只保留最后一次的完整覆盖值；
     *  2. 只有当前背景就是该壁纸时才应用；
     *  3. 串行执行 —— 场景包走「只改 CSS 里的属性块」的快速通道，绝不重装背景，
     *     因此不会出现并发写锁与 `_updateSeq` 让上一次结果作废而报失败。
     */
    private scheduleWallpaperPropertyApply(wallpaperPath: string): void {
        this.wallpaperPropertyPath = wallpaperPath;
        if (this.wallpaperPropertyApplyTimer) { clearTimeout(this.wallpaperPropertyApplyTimer); }
        this.wallpaperPropertyApplyTimer = setTimeout(() => {
            this.wallpaperPropertyApplyTimer = undefined;
            void this.flushWallpaperProperties();
        }, 60);
    }

    private async flushWallpaperProperties(): Promise<void> {
        if (this.wallpaperPropertyApplying) {
            this.wallpaperPropertyDirty = true;
            return;
        }
        const target = this.wallpaperPropertyPath;
        const current = resolveCurrentImagePath(
            getAppConfig().get<string>('imagePath') || ''
        );
        if (!current || this.normalizePath(current) !== this.normalizePath(target)) {
            return;
        }
        this.wallpaperPropertyApplying = true;
        try {
            const properties = getWallpaperPropertyOverrides(this.ctx.globalState, target);
            if (isWallpaperPkgPath(current)) {
                const applied = await PickList.applySceneProperties(properties);
                if (!applied) {
                    // CSS 里没有场景块（例如刚装好还没写入），退回一次完整应用。
                    await PickList.applyCurrentBackground();
                }
            } else {
                await PickList.applyCurrentBackground();
            }
            this.pushState(false);
        } catch (error) {
            console.error('[WallpaperStudio] Failed to apply wallpaper property:', error);
        } finally {
            this.wallpaperPropertyApplying = false;
            if (this.wallpaperPropertyDirty) {
                this.wallpaperPropertyDirty = false;
                this.scheduleWallpaperPropertyApply(this.wallpaperPropertyPath);
            }
        }
    }

    /** 高级页的「清除所有缓存与配置」：把扩展侧所有状态、缓存和设置恢复默认。 */
    private async resetAllState(): Promise<void> {
        this.wallpaperSyncGeneration++;
        this.wallpaperSyncPromise = undefined;
        this.wallpaperCompletedKey = '';
        if (this.thumbnailWriteTimer) { clearTimeout(this.thumbnailWriteTimer); }
        this.pendingThumbnails.clear();
        if (!(await clearRuntimeState())) { throw new Error('Failed to reset background state'); }
        await ensureWorkspaceRecord();
        const stateKeys = [
            'wallpaperStudioRecentImages',
            'wallpaperStudioWallpaperRemoved',
            'wallpaperStudioWallpaperProperties',
            'wallpaperStudioFolderRemoved',
            'wallpaperStudioOnlineFolder',
            'wallpaperStudioOnlineImageList',
            'wallpaperStudioWallpaperConfig',
            'wallpaperStudioWallpaperEnabled',
            'wallpaperStudioSourceMode',
            'wallpaperStudioSingleImageSource',
            'wallpaperStudio.windowImages',
            'wallpaperStudio.workspaceImages',
            'wallpaperStudio.workspacePaths',
            'wallpaperStudio.globalImage',
            'wallpaperStudio.windowOpacity',
            'wallpaperStudio.workspaceOpacity',
            'wallpaperStudio.windowBlur',
            'wallpaperStudio.workspaceBlur',
            'wallpaperStudioCacheReset20261101-v2'
        ];
        for (const key of stateKeys) {
            try { await this.ctx.globalState.update(key, undefined); } catch { /* 单个 key 清理失败不影响其余 */ }
        }
        try { this.thumbnails.clear(); } catch { /* 忽略 */ }

        this.wallpaperEntries = [];
        this.wallpaperUser = '';
        this.wallpaperNotice = '';
        this.notifiedWallpaperNotice = '';
        this.wallpaperLoading = false;
        this.wallpaperLoaded = 0;
        this.wallpaperTotal = 0;
        this.wallpaperLoadedOnce = false;
        this.wallpaperConfigPath = DEFAULT_WALLPAPER_CONFIG;
        this.wallpaperConfigEnabled = true;
        this.sourceMode = DEFAULT_SOURCE_MODE;
        this.folderCache = undefined;

        // 设置文件一并删除并重建为默认值（含默认模式 wallpaper、透明度/模糊度 0）。
        try { await resetSettings(); } catch (error) {
            console.warn('[WallpaperStudio] Failed to reset settings:', error);
        }

        // 面板侧的缩略图 / 场景首帧 / 界面偏好也要一起丢掉。
        try { await this.view?.webview.postMessage({ type: 'purgeLocalCache' }); } catch { /* view 可能已销毁 */ }
        // 关闭背景：会清掉 settings.json 里的 imagePath 和已注入的 CSS。
        try { await commands.executeCommand('wallpaperStudio.runAction', 7); } catch { /* 忽略 */ }

        onDidChangeGlobalState.fire();
        this.pushState();
    }

    /** 当前实际生效的来源模式；模式选择本身不应被配置文件可用性覆盖。 */
    private currentSourceMode(): 'file' | 'folder' | 'wallpaper' {
        return normalizeSourceMode(this.sourceMode);
    }

    /** 某个路径属于哪种来源：壁纸播放列表 / 目录媒体 / 本地文件。 */
    private modeOfPath(candidate: string): 'file' | 'folder' | 'wallpaper' {
        if (!candidate) { return this.currentSourceMode(); }
        const key = this.normalizePath(candidate);
        if (this.wallpaperEntries.some(entry => this.normalizePath(entry.path) === key)) {
            return 'wallpaper';
        }
        const folder = expandPathVariables(
            getAppConfig().get<string>('randomImageFolder') || ''
        );
        if (folder && this.isPathInFolder(candidate, folder)) { return 'folder'; }
        return 'file';
    }

    /** 来源标签仅用于提示；候选成员资格统一由 sourceMode 提供。 */
    private modeLabel(mode: 'file' | 'folder' | 'wallpaper'): string {
        switch (mode) {
            case 'wallpaper': return 'Wallpaper 配置';
            case 'folder': return '目录媒体';
            default: return '本地文件';
        }
    }

    /** 面板右下角的轻量提示（避免用系统弹窗打断操作）。 */
    private toast(text: string, level: 'info' | 'warning' | 'error' = 'info'): void {
        try {
            void this.view?.webview.postMessage({ type: 'toast', text, level });
        } catch {
            // 视图已销毁时忽略。
        }
    }

    /**
     * 播放列表为空的提示只弹一次：每次同步都弹会把用户烦死。
     *
     * 只在 wallpaper 模式下提示，其他模式跟播放列表无关。
     */
    private notifyWallpaperNotice(): void {
        if (this.currentSourceMode() !== 'wallpaper') { return; }
        if (!this.wallpaperNotice || this.wallpaperNotice === this.notifiedWallpaperNotice) { return; }
        this.notifiedWallpaperNotice = this.wallpaperNotice;
        this.toast(this.wallpaperNotice, 'warning');
    }

    /**
     * 重新读取 config.json 的播放列表。
     *
     * 只读「当前正在运行的用户」的节点：先按可信度判定用户，
     * 判定结果与上次不同就当作换账号，强制清缓存整份重读。
     *
     * @param force 为 true 时先清空 project.json 缓存，保证读到磁盘上的最新内容
     *              （「重新读取配置」按钮用）。
     */
    private wallpaperPlaylistContentKey(): string {
        let signature = 'missing';
        try {
            const stat = fs.statSync(this.wallpaperConfigPath);
            signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch { /* A newly created file invalidates the missing-file result. */ }
        return JSON.stringify([this.wallpaperConfigPath, signature, readRemovedWallpapers(this.ctx.globalState)]);
    }

    private syncWallpaperPlaylist(force = false): Promise<void> {
        const configPath = this.wallpaperConfigPath;
        const contentKey = this.wallpaperPlaylistContentKey();
        const storedUser = this.ctx.globalState.get<string>(WALLPAPER_USER_KEY, '');
        const key = JSON.stringify([contentKey, storedUser]);
        if (!force && this.wallpaperSyncPromise && key === this.wallpaperSyncKey) { return this.wallpaperSyncPromise; }
        if (!force && !this.wallpaperSyncPromise && key === this.wallpaperCompletedKey) { return Promise.resolve(); }
        this.wallpaperCompletedKey = '';
        const generation = ++this.wallpaperSyncGeneration;
        this.wallpaperSyncKey = key;
        const sync = this.syncWallpaperPlaylistImpl(force, generation, configPath).then(success => {
            const currentUser = this.ctx.globalState.get<string>(WALLPAPER_USER_KEY, '');
            if (success && generation === this.wallpaperSyncGeneration && contentKey === this.wallpaperPlaylistContentKey()
                && (currentUser === storedUser || currentUser === this.wallpaperUser)) {
                this.wallpaperCompletedKey = JSON.stringify([contentKey, currentUser]);
            }
        });
        this.wallpaperSyncPromise = sync;
        void sync.then(() => undefined, () => undefined).finally(() => {
            if (this.wallpaperSyncPromise === sync) {
                this.wallpaperSyncPromise = undefined;
            }
        });
        return sync;
    }

    private async syncWallpaperPlaylistImpl(force: boolean, generation: number, configPath: string): Promise<boolean> {
        const isCurrent = () => generation === this.wallpaperSyncGeneration && configPath === this.wallpaperConfigPath;
        this.wallpaperNotice = '';
        this.wallpaperLoading = true;
        this.wallpaperLoaded = 0;
        this.wallpaperTotal = 0;
        // 立刻让面板进入加载态（此时总数还没盘出来，显示 0/?），
        // 否则「没有壁纸」的空态会一直挂到解析结束。
        this.pushWallpaperLoadingProgress(true);
        try {
            if (!fs.existsSync(configPath)) {
                this.wallpaperEntries = [];
                this.wallpaperUser = '';
                forgetWallpaperPlaylist();
                return true;
            }

            const stored = this.ctx.globalState.get<string>(WALLPAPER_USER_KEY, '');
            const active = resolveActiveWallpaperUser(configPath, stored);
            const user = active?.user || '';
            const removed = readRemovedWallpapers(this.ctx.globalState);
            // 换用户等于换整个播放列表，项目元数据缓存也得一起丢。
            if (active && active.user !== this.wallpaperUser) { force = true; }
            if (force) {
                clearWallpaperProjectCache();
                forgetWallpaperPlaylist();
            }

            const entries = user
                ? await readWallpaperPlaylistAsync(
                    configPath,
                    removed,
                    user,
                    (loaded, total) => {
                        if (!isCurrent()) { return; }
                        this.wallpaperLoaded = loaded;
                        this.wallpaperTotal = total;
                        // 每项都上报；pushWallpaperLoadingProgress 内部按帧合并。
                        // 第一项（loaded=0）用来第一时间把总数告诉面板。
                        this.pushWallpaperLoadingProgress(loaded === 0);
                    }
                )
                : [];
            if (!isCurrent()) { return false; }
            this.wallpaperUser = user;
            this.wallpaperEntries = entries;
            if (user && user !== stored) {
                await this.ctx.globalState.update(WALLPAPER_USER_KEY, user);
                if (!isCurrent()) { return false; }
            }
            // 找不到当前用户（账号被换掉 / 删掉）或该用户播放列表为空，都要明确提示，
            // 而不是让面板停在"什么都没有"的状态里让用户自己猜。
            if (!this.wallpaperEntries.length) {
                forgetWallpaperPlaylist();
                this.wallpaperNotice = this.wallpaperUser
                    ? `Wallpaper 播放列表为空：当前用户「${this.wallpaperUser}」没有壁纸，请在 Wallpaper Engine 的播放列表里面添加壁纸。`
                    : '没有找到当前用户在 config.json 里的播放列表，请在 Wallpaper Engine 的播放列表里面添加壁纸。';
            } else {
                // 列表恢复了就允许下次空列表时重新提示。
                this.notifiedWallpaperNotice = '';
                // 随机 / 上一张 / 轮播的候选查询复用这份结果，不再同步重解析。
                rememberWallpaperPlaylist(
                    configPath, removed, user, entries
                );
            }
            return true;
        } catch (error) {
            if (!isCurrent()) { return false; }
            this.wallpaperEntries = [];
            forgetWallpaperPlaylist();
            this.wallpaperNotice = '读取 Wallpaper 播放列表失败，请检查 config.json 是否完整。';
            console.error('[WallpaperStudio] Failed to sync Wallpaper Engine playlist:', error);
            return false;
        } finally {
            // 只清标记，不在这里推送：调用方紧接着会 pushState，
            // 那份 state 同时带上新列表和 loading=false，面板不会先看到空列表。
            if (isCurrent()) {
                this.wallpaperLoading = false;
                this.wallpaperLoaded = this.wallpaperTotal;
                this.wallpaperLoadedOnce = true;
            }
        }
    }

    /**
     * 把场景预览页（WebWallGL + 场景脚本）的 webview URI 交给面板，面板用它当 iframe 源。
     * 页面写在 globalStorage 下，已属于允许根，无需额外申请。
     */
    private async sendScenePreviewPage(): Promise<void> {
        const webview = this.view?.webview;
        if (!webview) { return; }
        try {
            const { filePath, regenerated } = await ensureWallpaperScenePreviewPage(
                this.ctx.extensionPath,
                this.ctx.globalStorageUri.fsPath
            );
            this.ensureRootForFile(filePath);
            webview.postMessage({
                type: 'scenePreviewPage',
                uri: webview.asWebviewUri(Uri.file(filePath)).toString() + `?runtime=${fs.statSync(filePath).mtimeMs}`,
                // 面板把这份页面写进 srcdoc 时必须给内联脚本补上同一个 nonce。
                nonce: this.webviewNonce,
                regenerated
            });
        } catch (error) {
            webview.postMessage({
                type: 'scenePreviewPage',
                uri: '',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * Convert a local file path to a webview-safe URI.
     *
     * 在线地址不会原样返回：直接把 https 地址塞进 <img src> 会让每次 pushState
     * 都重新向云存储发请求(最近列表 20 条 = 20 个请求)，白烧流量费。图片下载后
     * 已落在缓存目录里，这里只引用那份本地副本；没有副本就返回空串走占位图。
     *
     * `cacheEntries` 由批量调用方预读一次，避免逐条 readdir。
     */
    private toWebviewUri(p: string): string {
        if (!p) { return ''; }
        const local = p;
        try {
            if (!fs.existsSync(local)) { return ''; }
            this.ensureRootForFile(local);
            const uri = this.view!.webview.asWebviewUri(Uri.file(local)).toString();
            if (isWallpaperPkgPath(local)) {
                const stat = fs.statSync(local);
                return `${uri}?v=${stat.mtimeMs}-${stat.size}`;
            }
            return uri;
        } catch {
            return '';
        }
    }

    private basename(p: string): string {
        return path.basename(p || '');
    }

    /** Seed initial allowed roots: extension dist, workspace folders, global/extension storage. */
    private seedAllowedRoots(): void {
        const add = (p: string | undefined) => {
            if (p) { this.allowedRoots.add(path.normalize(p)); }
        };
        add(Uri.joinPath(this.ctx.extensionUri, 'webview-dist').fsPath);
        add(Uri.joinPath(this.ctx.extensionUri, 'resources').fsPath);
        add(this.ctx.globalStorageUri?.fsPath);
        add(this.ctx.storageUri?.fsPath);
        (workspace.workspaceFolders || []).forEach(f => add(f.uri.fsPath));
    }

    /** Register the directory containing the given file path as a localResourceRoot. */
    private ensureRootForFile(filePath: string): void {
        const dir = path.normalize(path.dirname(filePath));
        if (!dir || this.isCovered(dir)) { return; }
        this.allowedRoots.add(dir);
        if (this.view) {
            this.view.webview.options = {
                enableScripts: true,
                localResourceRoots: this.computeRootUris()
            };
        }
    }

    /** Check whether `dir` is already inside any registered root. */
    private isCovered(dir: string): boolean {
        const target = normalizeComparablePath(dir);
        for (const root of this.allowedRoots) {
            if (target === normalizeComparablePath(root) || isPathInsideFolder(dir, root)) { return true; }
        }
        return false;
    }

    private computeRootUris(): Uri[] {
        return Array.from(this.allowedRoots).map(p => Uri.file(p));
    }

    private getHtml(webview: Webview): string {
        const indexFile = path.join(this.ctx.extensionPath, 'webview-dist', 'index.html');
        let html = '';
        try {
            // 500KB 的构建产物：进程内只读一次，面板重开时不再走磁盘。
            if (!StudioViewProvider.indexHtmlCache || StudioViewProvider.indexHtmlPath !== indexFile) {
                StudioViewProvider.indexHtmlCache = fs.readFileSync(indexFile, 'utf8');
                StudioViewProvider.indexHtmlPath = indexFile;
            }
            html = StudioViewProvider.indexHtmlCache;
        } catch {
            return this.fallbackHtml('webview-dist/index.html not found. Run `npm run build:webview`.');
        }

        const nonce = crypto.randomBytes(16).toString('base64');
        this.webviewNonce = nonce;
        // img-src/media-src 不放开 https:：所有预览都必须引用下载到本地的缓存副本，
        // 否则面板每次刷新都会回源云存储。frame-src 仍需 https 供在线图库 iframe 使用。
        // connect-src 只放开 cspSource：场景包预览要把 .pkg 读进内存再丢给渲染器，
        // 走的正是这个 scheme 的 fetch。场景页 iframe 也来自 cspSource。
        //
        // 场景首帧预览作为 srcdoc 子框架运行，会**继承这份策略**，所以这里要放开场景
        // 运行时真正用到的东西：WebWallGL 用 new Function 编译场景脚本（unsafe-eval）、
        // 用 blob: 建 Worker、用 blob: 取纹理和字体。不放开的话子框架里一个都跑不起来。
        const csp = [
            `default-src 'none'`,
            `img-src ${webview.cspSource} data: blob:`,
            `media-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource} data: blob:`,
            `script-src 'nonce-${nonce}' 'unsafe-eval'`,
            `connect-src ${webview.cspSource} data: blob:`,
            `worker-src ${webview.cspSource} blob:`,
            `frame-src ${webview.cspSource}`
        ].join('; ');

        // Always use our own CSP so the nonce below matches; drop any CSP shipped in the build.
        html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
        html = html.replace(/<head[^>]*>/i, m => `${m}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

        // Stamp nonce on every inline/external script.
        // The lookahead requires a real tag start (`<script>` / `<script ...` / `<script/`):
        // 面板 bundle 里只要出现字面量 "<script"（例如正则表达式字面量），不这样收窄就会
        // 把 nonce 注进字符串中间，产出 `Invalid regular expression flags` 这类语法错误。
        html = html.replace(/<script(?=[\s>/])(?![^>]*\bnonce=)/gi, m => `${m} nonce="${nonce}"`);

        return html;
    }

    private fallbackHtml(msg: string): string {
        return `<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:#ccc;background:#1e1e1e">
            <h3>Wallpaper Studio Studio</h3>
            <p>${msg}</p>
        </body></html>`;
    }
}

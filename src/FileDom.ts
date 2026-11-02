import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { commands, env, Uri, window, WorkspaceConfiguration, UIKind } from 'vscode';
import * as lockfile from 'proper-lockfile';
import version from './version';
import { SudoPromptHelper } from './SudoPromptHelper';
import * as fse from 'fs-extra';
import { getContext } from './global';
import { getSessionHash, getWindowCssFileName, isPerWindowEnabled } from './windowBackground';
import { detectPatchStateFromFile, PatchState, BOOTSTRAP_VERSION } from './patchState';
import { expandPathVariables, hasFileExtension, isVideoFile, pickRandomFromFolder } from './pathUtil';
import {
    getCorruptionWarningCss,
    getTransitionDeclaration,
    getTransitionReducedMotionCss,
    resolveBlendModeDeclaration,
    resolveBlendModeValue,
    resolveThemeBlendRules
} from './backgroundCss';
import { IMAGE_FADE_JS, PRELOAD_IMAGE_JS } from './loaderFragments';
import {
    CUSTOM_SCENE_HTML_FILE_NAME,
    CUSTOM_SCENE_JS_FILE_NAME,
    CUSTOM_WEBWALLGL_FILE_NAME,
    clearPatchBlock,
    hasPatchBlock,
    patchMediaCsp,
    restoreMediaCsp,
    patchCodeServerWorkbenchHtml,
    clearCodeServerWorkbenchHtmlPatch
} from './patchCleanup';
import { isWallpaperMpkgPath, isWallpaperPkgPath, validateWallpaperPkgFile } from './wallpaperPkg';
import { buildWallpaperSceneHtml, copyWallpaperScenePackage, loadWallpaperSceneInputs } from './wallpaperScene';
import { getWallpaperProjectDeclaration, getWallpaperPropertyOverrides, resolveWallpaperMediaPath } from './wallpaperEngine';
import { createSceneRenderConfig } from './sceneRender';
import {
    BackgroundApplyCancelledError,
    BackgroundDownloadError,
    BackgroundPatchError,
} from './downloadError';

export {
    BackgroundApplyCancelledError,
    BackgroundDownloadError,
    BackgroundPatchError,
    shouldTryNextAutoImage
} from './downloadError';

/** CSS 里场景配置块的边界标记，注入端按同一对标记解析。 */
const SCENE_BLOCK_RE = /\/\*wallpaper-studio-scene-start\*\/([\s\S]*?)\/\*wallpaper-studio-scene-end\*\//;

/**
 * 带权限处理地写文本文件：先直接写，失败则申请目录写权限后重试，最后尝试
 * 单独解锁该文件。VSCode 安装目录是受保护目录，三种情况都可能出现。
 */
async function writeTextWithPermission(filePath: string, content: string): Promise<void> {
    try {
        await fse.writeFile(filePath, content, { encoding: 'utf-8' });
        return;
    } catch {
        // Install dir is protected; unlock the folder first.
    }
    try {
        await ensureDirWritable(path.dirname(filePath));
        await fse.writeFile(filePath, content, { encoding: 'utf-8' });
        return;
    } catch (error) {
        if (isElevationCancelled(error)) {
            throw error;
        }
        // Existing files (workbench js) can keep a restrictive ACL after the
        // directory grant. Unlock that one file and retry.
    }
    await getFilePermissionFor(filePath);
    await fse.writeFile(filePath, content, { encoding: 'utf-8' });
}

/** 用系统工具给单个文件授权（Windows: takeown + icacls，其他平台: chmod）。 */
async function getFilePermissionFor(filePath: string): Promise<void> {
    const systemType = os.type();
    try {
        const quoted = quoteShellPath(filePath);
        const exists = await fse.pathExists(filePath);
        if (systemType === SystemType.WINDOWS) {
            const create = exists ? '' : `echo. > ${quoted} & `;
            await SudoPromptHelper.exec(
                `${create}takeown /f ${quoted} /a & icacls ${quoted} /grant Users:F`
            );
            return;
        }
        const chmodCmd = systemType === SystemType.MACOS ? 'chmod a+rwx' : 'chmod 666';
        if (exists) {
            await SudoPromptHelper.exec(`${chmodCmd} ${quoted}`);
        } else {
            await SudoPromptHelper.exec(`touch ${quoted} && ${chmodCmd} ${quoted}`);
        }
    } catch (error) {
        console.error(`Failed to get permission for ${filePath}:`, error);
        throw error;
    }
}

/** 当前窗口实际生效的 CSS 文件与它的 token（loader 用它绑定自己的样式文件）。 */
export function getActiveWindowCssFile(): { filePath: string; token: string } {
    const perWindow = isPerWindowEnabled();
    return perWindow
        ? { filePath: path.join(selectedWorkbench.root, getWindowCssFileName()), token: getSessionHash() }
        : { filePath: CUSTOM_CSS_FILE_PATH, token: SHARED_CSS_TOKEN };
}

/**
 * 只改写 CSS 里场景包的 `properties`，不重装背景。
 *
 * 调整壁纸用户配置或 XY 视角时，如果每次都走 `install()`（锁文件、复制 1.1MB
 * 运行时、重新打补丁 workbench bundle），不仅慢，连续拖动还会因并发写入和
 * `_updateSeq` 让前一次结果作废而报“更新失败”。这里只替换 JSON 块，注入端
 * 收到 CSS 变更后会向场景 iframe 发 `set-properties`，即改即生效。
 *
 * 返回 false 表示当前背景不是场景包（CSS 里没有场景块），调用方应跳过。
 */
export async function patchScenePropertiesInCss(properties: Record<string, unknown>): Promise<boolean> {
    if (!properties || !Object.keys(properties).length) { return false; }
    const { filePath } = getActiveWindowCssFile();
    let css: string;
    try {
        if (!(await fse.pathExists(filePath))) { return false; }
        css = await fse.readFile(filePath, 'utf-8');
    } catch {
        return false;
    }
    if (!SCENE_BLOCK_RE.test(css)) { return false; }

    let changed = false;
    const next = css.replace(SCENE_BLOCK_RE, (match, body: string) => {
        let config: any;
        try {
            config = JSON.parse(body);
        } catch {
            // 写盘时为了模板字符串安全做了转义，属性值里含 `${` 时 JSON 会解析失败。
            try {
                config = JSON.parse(body.replace(/\\`/g, '`').replace(/\\\$\{/g, '${'));
            } catch {
                return match;
            }
        }
        if (!config || typeof config !== 'object') { return match; }
        const merged = { ...(config.properties || {}), ...properties };
        if (JSON.stringify(merged) === JSON.stringify(config.properties || {})) { return match; }
        const json = JSON.stringify({ ...config, properties: merged })
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
        changed = true;
        return `/*wallpaper-studio-scene-start*/${json}/*wallpaper-studio-scene-end*/`;
    });
    if (!changed) { return true; }
    try {
        await writeTextWithPermission(filePath, next);
        return true;
    } catch (error) {
        console.warn('[FileDom] Failed to patch scene properties in CSS:', error);
        return false;
    }
}

interface AdditionalBundle {
    // Path relative to env.appRoot/out, e.g. 'vs/sessions/sessions.desktop.main.js'.
    relativePath: string;
}

interface WorkbenchTarget {
    name: string;
    root: string;
    js: string;
    css: string;
    bak: string;
    html?: string;
    // Additional renderer bundles that should receive the same loader IIFE so
    // VSCode auxiliary windows (AgentView / Open Agents Window) also pick up
    // the background. CSS is still authored once in the main workbench dir;
    // each bundle just self-injects a <style> referencing it.
    additionalBundles?: AdditionalBundle[];
}
/**
 * 文件路径配置，支持服务器模式
 */
const WORKBENCH_TARGETS: WorkbenchTarget[] = [
    {
        name: 'desktop', // vscode目录
        root: path.join(env.appRoot, "out", "vs", "workbench"), // 需要hook的文件目录
        js: 'workbench.desktop.main.js', // 需要hook的css文件名
        css: 'workbench.desktop.main.css', // 需要hook的js文件名
        bak: 'workbench.desktop.main.js.bak', // 备份文件名
        // AgentView (Agent Sessions) auxiliary window — separate Electron BrowserWindow
        // loaded from sessions.html → sessions.desktop.main.js. Patching it lets the
        // background show up there too. Optional: the file is only present in VSCode
        // builds that ship the AgentView; older builds will be skipped at runtime.
        additionalBundles: [
            { relativePath: path.join('vs', 'sessions', 'sessions.desktop.main.js') },
            // Cursor Agent Window (codename "Glass") — same workbench dir but a
            // separate renderer bundle picked when the window config has glass=true.
            { relativePath: path.join('vs', 'workbench', 'workbench.glass.main.js') }
        ]
    },
    {
        name: 'code-server',
        root: path.join(env.appRoot, "out", "vs", "code", "browser", "workbench"),
        js: 'workbench.js',
        css: 'workbench.css',
        bak: 'workbench.js.bak',
        html: 'workbench.html'
    }
];

// 选择当前运行环境对应的文件路径
function getWorkbenchTarget(): WorkbenchTarget {
    const preferredHost = determineHostPreference();

    const pickByName = (name: string): WorkbenchTarget | undefined => {
        return WORKBENCH_TARGETS.find((target) => target.name === name && fs.existsSync(path.join(target.root, target.js)));
    };

    if (preferredHost === 'desktop') {
        const desktopTarget = pickByName('desktop');
        if (desktopTarget) {
            return desktopTarget;
        }
    }

    if (preferredHost === 'code-server') {
        const webTarget = pickByName('code-server');
        if (webTarget) {
            return webTarget;
        }
    }

    return pickByName('desktop') || pickByName('code-server') || WORKBENCH_TARGETS[0];
}

function determineHostPreference(): 'desktop' | 'code-server' | undefined {
    const appHost = typeof env.appHost === 'string' ? env.appHost.toLowerCase() : undefined;
    if (appHost === 'desktop') {
        return 'desktop';
    }
    if (appHost === 'web') {
        return 'code-server';
    }

    if (env.uiKind === UIKind.Desktop) {
        return 'desktop';
    }
    if (env.uiKind === UIKind.Web) {
        return 'code-server';
    }

    const appName = (env.appName || '').toLowerCase();
    if (appName.includes('code-server') || appName.includes('vscode server')) {
        return 'code-server';
    }

    return undefined;
}

// 各路径静态变量
const selectedWorkbench = getWorkbenchTarget();
const JS_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.js);
const CSS_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.css);
const BAK_FILE_PATH = path.join(selectedWorkbench.root, selectedWorkbench.bak);
const HTML_FILE_PATH = selectedWorkbench.html ? path.join(selectedWorkbench.root, selectedWorkbench.html) : undefined;
const CUSTOM_CSS_FILE_NAME = 'css-wallpaper-studio.css';
const CUSTOM_JS_FILE_NAME = 'js-wallpaper-studio.js';
// 共用模式下随 reload trigger 一起下发的固定 token，注入端见到它就回到共享 CSS。
const SHARED_CSS_TOKEN = 'shared';
export const CUSTOM_CSS_FILE_PATH = path.join(selectedWorkbench.root, CUSTOM_CSS_FILE_NAME);
export const WORKBENCH_DIR = selectedWorkbench.root;
export const CUSTOM_JS_FILE_PATH = path.join(selectedWorkbench.root, CUSTOM_JS_FILE_NAME);
const APP_OUT_PATH = path.join(env.appRoot, 'out');
// Each entry is an additional bundle that needs the same loader IIFE injected
// (e.g. sessions.desktop.main.js for the AgentView window). Bak path mirrors
// the original with a .bak suffix so the file can be restored later.
const ADDITIONAL_BUNDLE_PATHS: { jsPath: string; bakPath: string }[] = (selectedWorkbench.additionalBundles ?? []).map((b) => ({
    jsPath: path.join(APP_OUT_PATH, b.relativePath),
    bakPath: path.join(APP_OUT_PATH, b.relativePath + '.bak')
}));
// Exported so the standalone vscode:uninstall script can use the same set
// when restoring files at extension removal time.
export const ADDITIONAL_BUNDLE_RELATIVE_PATHS: string[] = (selectedWorkbench.additionalBundles ?? []).map((b) => b.relativePath);
const IS_CODE_SERVER_TARGET = selectedWorkbench.name === 'code-server';
const WEB_RELATIVE_CSS_PATH = IS_CODE_SERVER_TARGET ? getWebRelativePath(CUSTOM_CSS_FILE_PATH) : undefined;
const WEB_RELATIVE_JS_PATH = IS_CODE_SERVER_TARGET ? getWebRelativePath(CUSTOM_JS_FILE_PATH) : undefined;
const CUSTOM_ASSET_DIR = path.join(selectedWorkbench.root, 'wallpaper-studio-assets');
const CUSTOM_WEBWALLGL_FILE_PATH = path.join(WORKBENCH_DIR, CUSTOM_WEBWALLGL_FILE_NAME);
const CUSTOM_SCENE_HTML_FILE_PATH = path.join(WORKBENCH_DIR, CUSTOM_SCENE_HTML_FILE_NAME);
const CUSTOM_SCENE_JS_FILE_PATH = path.join(WORKBENCH_DIR, CUSTOM_SCENE_JS_FILE_NAME);
const RELATIVE_URL_PLACEHOLDER = '__WALLPAPER_STUDIO_BASE__';
// Workbench CSP 需要允许视频 Blob、WebGL 场景纹理 Blob 和隔离场景 iframe。
// 本地视频经 vscode-file:// 由
// main.js 的 net.fetch(file://) 代理返回时缺少 Accept-Ranges（Electron 43 起不再
// 为 file:// 补 Range 头），Chromium 150 的 <video> 因此报 "no supported sources"。
// 修复方案：渲染层把 vscode-file 的视频 fetch 成 blob 再播放，并为渲染资源放行
// media-src/img-src 的 blob: 与 frame-src 的 vscode-file:。这里记录需要更新的 HTML 入口文件
// （主 workbench + sessions 辅助窗口共用同一份 CSP 规则）。
const DESKTOP_HTML_ENTRIES = [
    path.join(APP_OUT_PATH, 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
    path.join(APP_OUT_PATH, 'vs', 'sessions', 'electron-browser', 'sessions.html')
];

// 本进程内已确认「补丁块 == 期望内容」的 bundle：路径 → 补丁 hash + 文件 mtime/size。
// bootstrap 在同一扩展版本内是固定的，换图只改外部 CSS/JS，没必要每次都把十几 MB 的
// workbench bundle 读进来做正则比对；文件被 VS Code 更新或被别处改写时 mtime/size 会变，
// 自然落回完整校验。
const verifiedBundles = new Map<string, { hash: string; mtimeMs: number; size: number }>();

async function statSignature(filePath: string): Promise<{ mtimeMs: number; size: number } | undefined> {
    try {
        const st = await fse.stat(filePath);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return undefined;
    }
}

async function markBundleVerified(filePath: string, hash: string): Promise<void> {
    const sig = await statSignature(filePath);
    if (sig) {
        verifiedBundles.set(filePath, { hash, ...sig });
    } else {
        verifiedBundles.delete(filePath);
    }
}

function getWebRelativePath(filePath: string): string | undefined {
    try {
        const relativePath = path.relative(APP_OUT_PATH, filePath);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return undefined;
        }
        return relativePath.split(path.sep).join('/');
    } catch (error) {
        console.warn(`[FileDom] Failed to compute web path for ${filePath}:`, error);
        return undefined;
    }
}

enum SystemType {
    WINDOWS = 'Windows_NT',
    MACOS = 'Darwin',
    LINUX = 'Linux'
}

// One elevated grant per directory per process. New per-window CSS files keep
// appearing under workbench/, so unlocking the folder once avoids a UAC prompt
// on every new window.
const dirUnlockInFlight = new Map<string, Promise<void>>();

function quoteWinPath(filePath: string): string {
    return `"${filePath}"`;
}

/** POSIX shell 单引号转义：sudo 下路径里的 $ / 反引号 / 双引号都不会被解释。 */
function quotePosixPath(filePath: string): string {
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function quoteShellPath(filePath: string): string {
    return os.type() === SystemType.WINDOWS ? quoteWinPath(filePath) : quotePosixPath(filePath);
}

async function unlockDir(dirPath: string): Promise<void> {
    window.setStatusBarMessage(
        '正在开放背景文件目录写入权限，请在弹出的授权窗口中确认一次。 / Granting write access to the background folder. Please confirm the permission prompt once.',
        15000
    );
    const systemType = os.type();
    if (systemType === SystemType.WINDOWS) {
        const quoted = quoteWinPath(dirPath);
        // (OI)(CI) = new files and subfolders inherit Users:F, so later windows
        // can create css-wallpaper-studio.<session>.css without another prompt.
        await SudoPromptHelper.exec(
            `takeown /f ${quoted} /a & icacls ${quoted} /grant "Users:(OI)(CI)F"`
        );
        return;
    }
    if (systemType === SystemType.MACOS || systemType === SystemType.LINUX) {
        await SudoPromptHelper.exec(`chmod a+rwx ${quotePosixPath(dirPath)}`);
    }
}

async function ensureDirWritable(dirPath: string): Promise<void> {
    const normalized = path.normalize(dirPath);
    const existing = dirUnlockInFlight.get(normalized);
    if (existing) {
        await existing;
        return;
    }
    const task = unlockDir(normalized).catch((error) => {
        dirUnlockInFlight.delete(normalized);
        throw error;
    });
    dirUnlockInFlight.set(normalized, task);
    await task;
}

function isElevationCancelled(error: unknown): boolean {
    return /did not grant permission|canceled|cancelled/i.test(String(error));
}

export async function removeWallpaperStudioCssFiles(): Promise<void> {
    if (!(await fse.pathExists(WORKBENCH_DIR))) {
        return;
    }
    let names: string[] = [];
    try {
        names = await fse.readdir(WORKBENCH_DIR);
    } catch (error) {
        console.warn('[FileDom] Failed to list workbench CSS files:', error);
        return;
    }
    const cssFiles = names.filter(name => name.startsWith('css-wallpaper-studio') && name.endsWith('.css'));
    const systemType = os.type();
    let dirUnlocked = false;
    for (const name of cssFiles) {
        const filePath = path.join(WORKBENCH_DIR, name);
        try {
            await fse.remove(filePath);
            continue;
        } catch {
            if (!dirUnlocked) {
                try {
                    await ensureDirWritable(WORKBENCH_DIR);
                    dirUnlocked = true;
                    await fse.remove(filePath);
                    continue;
                } catch (error) {
                    if (isElevationCancelled(error)) {
                        throw error;
                    }
                }
            }
        }
        try {
            if (systemType === SystemType.WINDOWS) {
                await SudoPromptHelper.exec(`del ${quoteWinPath(filePath)}`);
            } else {
                await SudoPromptHelper.exec(`rm ${quotePosixPath(filePath)}`);
            }
        } catch (error) {
            console.warn(`[FileDom] Failed to remove ${filePath}:`, error);
        }
    }
}

// 每个窗口会话都会新建一份 css-wallpaper-studio.<session>.css，而 session 在重载
// 后就会变，旧文件不会再有人读。这里做 best-effort 回收：绝不提权、绝不弹窗，删不掉
// 就留给下次启动。按 mtime 判定过期，误删一个长期开着又没换过图的窗口的文件时，
// 该窗口 loadCss 的 fetch 会失败并保留已在 DOM 里的样式，不会白屏。
const WINDOW_CSS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_CSS_FILE_RE = /^css-wallpaper-studio\..+\.css$/;

export async function collectStaleWindowCssFiles(): Promise<void> {
    try {
        if (!(await fse.pathExists(WORKBENCH_DIR))) {
            return;
        }
        const currentName = getWindowCssFileName();
        const names = await fse.readdir(WORKBENCH_DIR);
        const now = Date.now();
        for (const name of names) {
            if (name === CUSTOM_CSS_FILE_NAME || name === currentName) {
                continue;
            }
            if (!WINDOW_CSS_FILE_RE.test(name)) {
                continue;
            }
            const filePath = path.join(WORKBENCH_DIR, name);
            try {
                const stat = await fse.stat(filePath);
                if (now - stat.mtimeMs < WINDOW_CSS_MAX_AGE_MS) {
                    continue;
                }
                await fse.remove(filePath);
            } catch {
                // 被占用或无写权限：跳过，下次启动再试。
            }
        }
    } catch (error) {
        console.warn('[FileDom] Failed to collect stale window CSS files:', error);
    }
}

/**
 * 补丁状态机（A1）：按主 workbench bundle 的实际内容标记判定补丁状态。
 * - latest：已按当前 bootstrap 版本打过补丁；
 * - legacy：打过旧版补丁（需要升级）；
 * - none：文件被还原 / VS Code 更新替换 / 首次安装。
 * 主文件缺失时也返回 none，保持静默。
 */
export async function detectPatchState(): Promise<PatchState> {
    return detectPatchStateFromFile(JS_FILE_PATH);
}

export class FileDom {
    private readonly filePath: string;
    private readonly extName = "wallpaperStudio";
    private imagePath: string;
    private readonly imageOpacity: number;
    private readonly sizeModel: string;
    private readonly blur: number;
    private readonly blendModel: string;
    private readonly systemType: string;
    private readonly forceHttpsUpgrade: boolean;
    private readonly transitionEnabled: boolean;
    private readonly shouldApply: () => boolean;
    private readonly windowCssFilePath: string;
    public readonly windowCssToken: string;
    private readonly silent: boolean;
    private upCssContent: string = '';
    private bakStatus: boolean = false;
    private bakJsContent: string = '';
    private workConfig: WorkspaceConfiguration;
    private initializePromise?: Promise<void>;
    private isVideo: boolean = false;
    private isWallpaperPkg: boolean = false;
    private wallpaperPkgSourcePath?: string;
    private wallpaperSceneUrl?: string;
    public didUpdateCss: boolean = false;
    public didUpdateDynamicJs: boolean = false;

    constructor(
        workConfig: WorkspaceConfiguration,
        imagePath: string,
        opacity: number,
        sizeModel: string = 'cover',
        blur: number = 0,
        blendModel: string = '',
        shouldApply: () => boolean = () => true,
        silent: boolean = false
    ) {
        this.workConfig = workConfig;
        this.filePath = JS_FILE_PATH;
        this.imagePath = imagePath;
        this.imageOpacity = Math.min(opacity, 0.8);
        this.sizeModel = sizeModel || "cover";
        this.blur = blur;
        this.blendModel = blendModel || this.workConfig.get('blendModel', '');
        this.systemType = os.type();
        this.forceHttpsUpgrade = this.workConfig.get('forceHttpsUpgrade', true);
        // 背景切换动画始终启用；仍尊重系统减少动态效果设置。
        this.transitionEnabled = true;
        this.shouldApply = shouldApply;
        // 共用模式(perWindowBackground=false)下直接写共享 CSS 文件，并用固定 token
        // 让注入端把 __wallpaperStudioCssUrl 复位到共享地址。
        const activeCss = getActiveWindowCssFile();
        this.windowCssToken = activeCss.token;
        this.windowCssFilePath = activeCss.filePath;
        this.silent = silent;
        
        this.initializePromise = this.initializeImage().catch((error: unknown) => {
            console.error('[FileDom] Failed to preprocess image:', error);
            throw error;
        });
        // clearBackground 分支不会 await 这个 Promise；挂一个吞掉的副本，
        // 避免壁纸缺失时产生 unhandledRejection（它只是日志噪音，但会吓到用户）。
        void this.initializePromise.catch(() => undefined);
    }

    // 检测是否为视频文件
    private checkIsVideo(filePath: string): boolean {
        return isVideoFile(filePath);
    }

    /**
     * 若 imagePath 指向一个本地文件夹（无扩展名且是目录），随机返回其中一张
     * 图片/视频的完整路径；URL、data:、单文件或不存在一律返回 undefined。
     */
    private async resolveFolderBackground(): Promise<string | undefined> {
        const lower = this.imagePath.toLowerCase();
        if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:')) {
            return undefined;
        }
        if (hasFileExtension(this.imagePath)) {
            return undefined;
        }
        return pickRandomFromFolder(this.imagePath);
    }

    // 本地图片转换为vscode可访问路径
    private async initializeImage(): Promise<void> {
        // A3：展开 ~ / ${ENV} / $ENV；无扩展名的本地路径按「文件夹」处理，随机取一张
        // 作为本次背景（支持直接把壁纸目录填进 imagePath）。
        // 注意只对本地路径展开：http/data URL 的查询串里可能含 $ 字面量，不能动。
        const lowerInput = this.imagePath.toLowerCase();
        if (!lowerInput.startsWith('http://') && !lowerInput.startsWith('https://') && !lowerInput.startsWith('data:')) {
            this.imagePath = expandPathVariables(this.imagePath);
        }
        const folderPicked = await this.resolveFolderBackground();
        if (folderPicked) {
            this.imagePath = folderPicked;
        }
        if (!this.imagePath.toLowerCase().startsWith('http') && !this.imagePath.toLowerCase().startsWith('data:')) {
            this.imagePath = resolveWallpaperMediaPath(this.imagePath);
        }

        /**
         * 本地壁纸必须真实存在，否则**在打补丁之前**就中止。
         *
         * 之前这里不校验：路径不存在时仍会走完整 install()，把 workbench 打上补丁、
         * 写出一份指向不存在文件的 CSS。结果是背景空白，而 workbench 一直是"已修改"
         * 状态，VS Code 于是弹「安装似乎损坏」；用户点恢复后补丁被还原，扩展彻底失效
         * （这正是"删了壁纸文件夹之后背景消失 + 报 Code 损坏"的由来）。
         */
        if (!this.imagePath.toLowerCase().startsWith('http') && !this.imagePath.toLowerCase().startsWith('data:')) {
            if (!fs.existsSync(this.imagePath)) {
                throw new BackgroundPatchError(
                    '壁纸文件不存在，可能已被移动或删除：' + this.imagePath
                );
            }
        }

        let lowerPath = this.imagePath.toLowerCase();
        if (isWallpaperMpkgPath(this.imagePath)) {
            throw new Error('Wallpaper Engine .mpkg（PKGM）暂不支持，请改用 .pkg 场景包。');
        }

        if (lowerPath.startsWith('http://') || lowerPath.startsWith('https://')) {
            // 在线图源已移除：只支持本地文件、目录与 Wallpaper Engine 场景包。
            throw new Error('在线图片地址不再支持，请改用本地壁纸 / Online image URLs are no longer supported.');
        }

        this.isVideo = this.checkIsVideo(this.imagePath);
        this.isWallpaperPkg = isWallpaperPkgPath(this.imagePath);
        if (isWallpaperMpkgPath(this.imagePath)) {
            throw new Error('Wallpaper Engine .mpkg（PKGM）暂不支持，请改用 .pkg 场景包。');
        }
        if (this.isWallpaperPkg) {
            await validateWallpaperPkgFile(this.imagePath);
            this.wallpaperPkgSourcePath = this.imagePath;
        }

        if (
            !lowerPath.startsWith('http://') &&
            !lowerPath.startsWith('https://') &&
            !lowerPath.startsWith('data:')
        ) {
            try {
                if (IS_CODE_SERVER_TARGET) {
                    const assetUrl = await this.prepareCodeServerAsset(this.imagePath);
                    if (assetUrl) {
                        this.imagePath = assetUrl;
                    } else if (!this.isVideo && !this.isWallpaperPkg) {
                        await this.imageToBase64();
                    } else {
                        this.localImgToVsc();
                    }
                } else {
                    this.localImgToVsc();
                }
            } catch (e) {
                if (!this.isVideo && !this.isWallpaperPkg) {
                    await this.imageToBase64();
                } else {
                    this.localImgToVsc();
                }
            }
        }
    }
    public async install(): Promise<boolean> {
        // 先完成壁纸预处理与校验：非法路径必须在这里抛错，
        // 不能等到后面的 applyPatch —— 那会先改 workbench、再留下指向空文件的 CSS。
        await this.ensureInitialized();

        if (!(await this.checkFileExists())) {
            if (this.silent) {
                throw new BackgroundPatchError('Workbench file is missing');
            }
            return false;
        }

        await this.handleLegacyCleanup();
        await this.ensureBackup();

        const patched = await this.applyPatch();
        if (patched) {
            // 视频背景与场景包渲染依赖 CSP 的 blob: 媒体/贴图和隔离 iframe。
            // 主窗口 + 辅助窗口(sessions) 的 HTML 都要同步处理，
            // 缺文件（老版本 VSCode）时静默跳过。
            try {
                await this.patchMediaCspForEntries();
            } catch (e) {
                console.warn('[FileDom] Failed to patch media CSP:', e);
            }
        }
        return patched;
    }

    // 检查文件是否存在
    private async checkFileExists(): Promise<boolean> {
        const isExist = await fse.pathExists(this.filePath);
        if (!isExist) {
            if (!this.silent) {
                await window.showErrorMessage(`文件不存在，提醒开发者修复吧！`);
            }
            return false;
        }
        return true;
    }

    // 旧版本清理
    private async handleLegacyCleanup(): Promise<void> {
        const vsContext = getContext();
        const clearCssNum = Number(vsContext.globalState.get('ext_wallpaperStudio_clear_v2')) || 0;

        if (clearCssNum <= 5) {
            const cssContent = await this.getContent(CSS_FILE_PATH);
            if (this.getPatchContent(cssContent)) {
                this.upCssContent = this.clearCssContent(cssContent);
            } else {
                vsContext.globalState.update('ext_wallpaperStudio_clear_v2', clearCssNum + 1);
            }
        }

    }

    // 是否存在备份文件
    private async ensureBackup(): Promise<void> {
        const bakExist = await fse.pathExists(BAK_FILE_PATH);
        if (!bakExist) {
            this.bakStatus = true;
            window.setStatusBarMessage(`首次使用正在获取权限及备份文件，处理中... / First use is getting permission and backing up files, processing...`, 10000);
        }
    }

    // 应用补丁
    private async applyPatch(): Promise<boolean> {
        const lockPath = path.join(os.tmpdir(), 'vscode-background.lock');
        let release: (() => Promise<void>) | undefined;

        try {
            await this.ensureInitialized();

            if (!this.shouldApply()) {
                throw new BackgroundApplyCancelledError();
            }

            if (!(await fse.pathExists(lockPath))) {
                await fse.writeFile(lockPath, '', 'utf-8');
            }

            release = await lockfile.lock(lockPath, {
                retries: {
                    retries: 10,
                    minTimeout: 100,
                    maxTimeout: 1000,
                    randomize: true
                },
                stale: 20000
            });

            if (!this.shouldApply()) {
                throw new BackgroundApplyCancelledError();
            }

            // Save dynamic assets first. The patched workbench bundle only keeps a
            // stable bootstrap; feature code lives in cache-busted external files.
            try {
                if (this.isWallpaperPkg) {
                    await this.saveWallpaperSceneRuntimeContent();
                }
                this.didUpdateCss = await this.saveCssContent();
                this.didUpdateDynamicJs = await this.saveDynamicJsContent();
            } catch (e) {
                // 静默模式(定时自动换图)不能弹窗，直接抛给上层去挑下一张候选图。
                if (this.silent) {
                    throw new BackgroundPatchError(String(e));
                }
                window.showErrorMessage('Failed to write background assets: ' + e);
                return false;
            }

            const content = this.getJs().trim();
            if (!content) {
                if (this.silent) {
                    throw new BackgroundPatchError('Generated patch content is empty');
                }
                return false;
            }

            const patchHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);

            // Patch main workbench bundle. captureBak: true means if no backup exists
            // yet we save the pre-patch content for safety.
            const mainResult = await this.patchOneJsFile(this.filePath, BAK_FILE_PATH, content, true);
            if (mainResult === 'failed') {
                if (this.silent) {
                    throw new BackgroundPatchError('Failed to patch workbench file');
                }
                return false;
            }

            // Patch any additional bundles (AgentView etc). Skipping ones that don't
            // exist keeps us forward/backward compatible across VSCode versions.
            let anyAdditionalChanged = false;
            for (const { jsPath, bakPath } of ADDITIONAL_BUNDLE_PATHS) {
                if (!(await fse.pathExists(jsPath))) continue;
                const r = await this.patchOneJsFile(jsPath, bakPath, content, false);
                if (r === 'patched') anyAdditionalChanged = true;
                if (r === 'failed') {
                    // Don't abort the whole install — the main window is already
                    // fine, the auxiliary one just won't have a background.
                    console.error(`[FileDom] Failed to patch additional bundle: ${jsPath}`);
                }
            }

            const htmlChanged = await this.saveCodeServerHtmlContent(`${version}-${patchHash}`);
            // Reload window if any JS bundle was rewritten or the HTML cache key
            // changed. The main reload covers main + sessions windows that are
            // currently open in this VSCode session.
            this.requiresReload = mainResult === 'patched' || anyAdditionalChanged || htmlChanged;
            return true;

        } catch (error: any) {
            if (error instanceof BackgroundApplyCancelledError || error instanceof BackgroundDownloadError) {
                throw error;
            }
            // 静默模式必须先于 handlePatchError 返回：后者是个 await 住的模态框，
            // 会把定时换图的调度器(isAutoRunning)一直卡住，而且 BackgroundPatchError
            // 本来就是上面几处静默分支自己抛的，不该再被当成未知错误弹一次窗。
            if (this.silent) {
                if (error instanceof BackgroundPatchError) {
                    throw error;
                }
                console.error('[FileDom] applyPatch error (silent):', error);
                throw new BackgroundPatchError((error && (error.message || error.toString())) || 'Failed to install background patch');
            }
            await this.handlePatchError(error);
            return false;
        } finally {
            if (release) {
                try {
                    await release();
                } catch (err) {
                    console.error(`Failed to unlock ${lockPath}:`, err);
                }
            }
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.initializePromise) {
            return;
        }
        const pending = this.initializePromise;
        try {
            await pending;
            if (this.initializePromise === pending) {
                this.initializePromise = undefined;
            }
        } catch (error) {
            if (this.initializePromise === pending) {
                this.initializePromise = undefined;
            }
            throw error;
        }
    }

    /**
     * Categorize an installation error (permission, lock, missing file, unknown)
     * and offer the user contextual recovery actions instead of a flat message.
     */
    private async handlePatchError(error: any): Promise<void> {
        const rawMsg: string = (error && (error.message || error.toString())) || 'Unknown error';
        const code: string = (error && error.code) ? String(error.code) : '';
        const lower = (rawMsg + ' ' + code).toLowerCase();

        type Kind = 'permission' | 'locked' | 'missing' | 'unknown';
        let kind: Kind = 'unknown';
        if (/eacces|eperm|access\s*denied|operation\s*not\s*permitted|权限/.test(lower)) {
            kind = 'permission';
        } else if (/ebusy|lock\s*file|already\s*being\s*held|locked/.test(lower)) {
            kind = 'locked';
        } else if (/enoent|no\s*such\s*file|not\s*found/.test(lower)) {
            kind = 'missing';
        }

        const intro: Record<Kind, string> = {
            permission: '权限不足：写入 VSCode 核心文件失败。请尝试以管理员身份重新打开 VSCode，或关闭其他正在写入该文件的进程。 / Permission denied while patching VSCode core file.',
            locked:     '文件被占用：另一个 VSCode 实例可能正在写入相同文件。请关闭其他窗口后重试。 / The workbench file is locked by another process.',
            missing:    '未找到 VSCode 核心文件：可能在你升级 / 修复 VSCode 后路径已变化。 / Required VSCode core file is missing.',
            unknown:    '安装补丁失败 / Failed to install background patch.'
        };

        const buttons: string[] = ['Retry / 重试'];
        if (kind === 'permission' && this.systemType === SystemType.WINDOWS) {
            buttons.push('Reopen as Admin / 以管理员身份重开');
        }
        buttons.push('Open Log / 查看日志');

        const detail = `${intro[kind]}\n\n[${kind.toUpperCase()}] ${rawMsg}`;
        console.error('[FileDom] applyPatch error:', error);

        const choice = await window.showErrorMessage(detail, ...buttons);
        if (!choice) { return; }
        if (choice === 'Retry / 重试') {
            // Re-attempt without recursion blowing the stack; small delay so any
            // transient lock has a chance to clear. Restart image preprocessing
            // so a previous failed download is not reused.
            this.initializePromise = this.initializeImage().catch((error: unknown) => {
                console.error('[FileDom] Failed to preprocess image:', error);
                throw error;
            });
            setTimeout(() => { void this.applyPatch(); }, 300);
            return;
        }
        if (choice === 'Reopen as Admin / 以管理员身份重开') {
            await window.showInformationMessage(
                '请手动关闭当前 VSCode 窗口，然后右键 VSCode 图标 → "以管理员身份运行"。 / Close VSCode, then right-click its icon and choose "Run as administrator".',
                { modal: true },
                'OK'
            );
            return;
        }
        if (choice === 'Open Log / 查看日志') {
            try {
                await commands.executeCommand('workbench.action.toggleDevTools');
            } catch (e) {
                console.warn('[FileDom] toggleDevTools failed:', e);
            }
            return;
        }
    }

    // Patch one JS bundle: replace any existing wallpaper-studio marker block
    // with `content`, or append it if absent. Optionally captures a pre-patch
    // backup the first time it sees the file unpatched.
    //
    // Returns 'unchanged' if the file already matches, 'patched' if rewritten,
    // 'failed' if the write didn't go through.
    private async patchOneJsFile(
        jsPath: string,
        bakPath: string,
        content: string,
        captureBak: boolean
    ): Promise<'unchanged' | 'patched' | 'failed'> {
        const result = await this.patchOneJsFileInner(jsPath, bakPath, content, captureBak);
        const hash = crypto.createHash('md5').update(content.trim()).digest('hex');
        if (result === 'failed') {
            verifiedBundles.delete(jsPath);
        } else {
            await markBundleVerified(jsPath, hash);
        }
        return result;
    }

    private async patchOneJsFileInner(
        jsPath: string,
        bakPath: string,
        content: string,
        captureBak: boolean
    ): Promise<'unchanged' | 'patched' | 'failed'> {
        try {
            const cached = verifiedBundles.get(jsPath);
            if (cached && cached.hash === crypto.createHash('md5').update(content.trim()).digest('hex')) {
                const sig = await statSignature(jsPath);
                if (sig && sig.mtimeMs === cached.mtimeMs && sig.size === cached.size) {
                    return 'unchanged';
                }
            }

            const currentContent = await this.getContent(jsPath);
            const markerRe = new RegExp(`\\/\\*ext-${this.extName}-start\\*\\/([\\s\\S]*?)\\/\\*ext-${this.extName}-end\\*\\/`);
            const match = currentContent.match(markerRe);
            if (match && match[0].trim() === content.trim()) {
                return 'unchanged';
            }

            const stripped = this.clearCssContent(currentContent);

            // Capture the original (pre-patch) content as backup if requested
            // and we haven't backed up before. Two cases handled differently:
            // - Main bundle: relies on the bakStatus/bakJsContent flow that the
            //   constructor + ensureBackup() already prepared for `this.filePath`.
            // - Additional bundles: write directly here on first sight.
            if (captureBak) {
                if (jsPath === this.filePath) {
                    if (this.bakStatus) {
                        this.bakJsContent = stripped;
                    }
                } else {
                    if (!(await fse.pathExists(bakPath))) {
                        try {
                            await this.writeWithPermission(bakPath, stripped);
                        } catch (err) {
                            console.error(`[FileDom] Failed to write backup ${bakPath}:`, err);
                        }
                    }
                }
            } else if (!(await fse.pathExists(bakPath))) {
                // Even when not "first-time captureBak", make sure each additional
                // bundle gets a one-shot backup the first time we touch it. This
                // way uninstall has something to fall back to if the marker block
                // ever drifts.
                try {
                    await this.writeWithPermission(bakPath, stripped);
                } catch (err) {
                    console.error(`[FileDom] Failed to write backup ${bakPath}:`, err);
                }
            }

            const newContent = stripped + content;
            if (jsPath === this.filePath) {
                // Keep main-bundle path going through the existing saveContent()
                // so the legacy upCssContent + bakFile machinery still fires.
                return (await this.saveContent(newContent)) ? 'patched' : 'failed';
            }

            try {
                await this.writeWithPermission(jsPath, newContent);
                return 'patched';
            } catch (err) {
                console.error(`[FileDom] writeWithPermission failed for ${jsPath}:`, err);
                return 'failed';
            }
        } catch (err) {
            console.error(`[FileDom] patchOneJsFile error for ${jsPath}:`, err);
            return 'failed';
        }
    }

    // 获取单个文件权限（目录授权仍盖不住的已有受保护文件才走这里）
    public async getFilePermission(filePath: string): Promise<void> {
        await getFilePermissionFor(filePath);
    }

    // 清理补丁内容
    public async uninstall(): Promise<boolean> {
        try {
            const content = this.clearCssContent(await this.getContent(this.filePath));
            await this.saveContent(content);

            // Strip our loader from any additional bundles (AgentView sessions
            // bundle on desktop). Missing files are tolerated — that just means
            // this VSCode build doesn't ship the auxiliary bundle.
            for (const { jsPath } of ADDITIONAL_BUNDLE_PATHS) {
                if (!(await fse.pathExists(jsPath))) continue;
                try {
                    const raw = await this.getContent(jsPath);
                    const cleaned = this.clearCssContent(raw);
                    if (cleaned !== raw) {
                        await this.writeWithPermission(jsPath, cleaned);
                    }
                } catch (err) {
                    console.error(`[FileDom] Failed to strip patch from ${jsPath}:`, err);
                }
            }

            // Remove CSS files (shared fallback + per-window copies)
            await removeWallpaperStudioCssFiles();

            for (const generatedPath of [
                CUSTOM_JS_FILE_PATH,
                CUSTOM_WEBWALLGL_FILE_PATH,
                CUSTOM_SCENE_HTML_FILE_PATH,
                CUSTOM_SCENE_JS_FILE_PATH
            ]) {
                if (!(await fse.pathExists(generatedPath))) continue;
                try {
                    await fse.remove(generatedPath);
                } catch {
                    if (this.systemType === SystemType.WINDOWS) {
                        await SudoPromptHelper.exec(`del "${generatedPath}"`);
                    } else {
                        await SudoPromptHelper.exec(`rm "${generatedPath}"`);
                    }
                }
            }

            await this.clearCodeServerHtmlContent();
            // 还原 CSP：卸载时撤销媒体、图片与场景 iframe 的来源放行。
            try {
                await this.restoreMediaCspForEntries();
            } catch (e) {
                console.warn('[FileDom] Failed to restore media CSP:', e);
            }

            return true;
        } catch (error) {
            await window.showErrorMessage(`卸载失败: ${error}`);
            return false;
        }
    }

    // 清除背景
    public async clearBackground(): Promise<boolean> {
        try {
            // 补丁仍然留在 workbench 里，所以「隐藏安装损坏提示」的 CSS 必须保留。
            // 之前这里写空字符串：一旦用户清掉背景（或壁纸文件丢失触发清理），
            // VS Code 立刻弹出「安装似乎损坏」，点恢复就把补丁还原了。
            await this.writeWithPermission(this.windowCssFilePath, getCorruptionWarningCss());
            this.requiresReload = false;
            return true;
        } catch (error) {
            if (this.silent) {
                throw new BackgroundPatchError(`清除背景失败: ${error}`);
            }
            await window.showErrorMessage(`清除背景失败: ${error}`);
            return false;
        }
    }

    // 读取原文件内容
    private async getContent(filePath: string): Promise<string> {
        return await fse.readFile(filePath, 'utf-8');
    }

    /**
     * 放宽 Workbench CSP 中的媒体/图片 Blob 与场景 iframe 来源限制。
     * 只改含 CSP meta 的 HTML 入口文件，
     * 幂等（重复安装不叠加）。入口列表桌面端覆盖主窗口 + sessions 辅助窗口，
     * code-server 复用 selectedWorkbench.html。
     */
    private getMediaCspEntries(): string[] {
        const entries: string[] = [];
        if (IS_CODE_SERVER_TARGET) {
            if (HTML_FILE_PATH) {
                entries.push(HTML_FILE_PATH);
            }
        } else {
            for (const htmlPath of DESKTOP_HTML_ENTRIES) {
                if (fse.pathExistsSync(htmlPath)) {
                    entries.push(htmlPath);
                }
            }
        }
        return entries;
    }

    private async patchMediaCspForEntries(): Promise<void> {
        for (const htmlPath of this.getMediaCspEntries()) {
            try {
                const raw = await this.getContent(htmlPath);
                const patched = patchMediaCsp(raw);
                if (patched !== raw) {
                    await this.writeWithPermission(htmlPath, patched);
                    if (htmlPath.indexOf('workbench.html') !== -1) {
                        console.log(`[FileDom] media CSP patched in ${htmlPath}`);
                    }
                }
            } catch (e) {
                console.warn(`[FileDom] Failed to patch media CSP in ${htmlPath}:`, e);
            }
        }
    }

    private async restoreMediaCspForEntries(): Promise<void> {
        for (const htmlPath of this.getMediaCspEntries()) {
            try {
                const raw = await this.getContent(htmlPath);
                const restored = restoreMediaCsp(raw);
                if (restored !== raw) {
                    await this.writeWithPermission(htmlPath, restored);
                }
            } catch (e) {
                console.warn(`[FileDom] Failed to restore media CSP in ${htmlPath}:`, e);
            }
        }
    }

    // 写入文件内容
    private async saveContent(content: string): Promise<boolean> {
        if (this.bakStatus) {
            await this.bakFile();
        }

        await this.writeWithPermission(this.filePath, content);

        if (this.upCssContent) {
            await this.writeWithPermission(CSS_FILE_PATH, this.upCssContent);
            this.upCssContent = '';
        }

        return true;
    }

    // 写入文件内容，带权限处理
    private async writeWithPermission(filePath: string, content: string): Promise<void> {
        await writeTextWithPermission(filePath, content);
    }

    // 写入备份文件
    private async bakFile(): Promise<void> {
        await this.writeWithPermission(BAK_FILE_PATH, this.bakJsContent);
    }

    public requiresReload: boolean = true;

    // 写入css内容
    private async saveCssContent(): Promise<boolean> {
        const css = this.getCss();
        let changed = true;
        try {
            if (await fse.pathExists(this.windowCssFilePath)) {
                const current = await fse.readFile(this.windowCssFilePath, 'utf-8');
                if (current === css) {
                    changed = false;
                }
            }
        } catch {
            // Fall through to write; permission handling below will surface real failures.
        }
        if (changed) {
            await this.writeWithPermission(this.windowCssFilePath, css);
        }
        // Shared file is only a pre-handshake fallback. Seed it when missing so a
        // brand-new window has something to show before this session's trigger.
        try {
            if (!(await fse.pathExists(CUSTOM_CSS_FILE_PATH))) {
                await this.writeWithPermission(CUSTOM_CSS_FILE_PATH, css);
            }
        } catch (error) {
            console.warn('[FileDom] Failed to seed shared CSS fallback:', error);
        }
        return changed;
    }

    private async saveDynamicJsContent(): Promise<boolean> {
        const js = this.getDynamicJs();
        try {
            if (await fse.pathExists(CUSTOM_JS_FILE_PATH)) {
                const current = await fse.readFile(CUSTOM_JS_FILE_PATH, 'utf-8');
                if (current === js) {
                    return false;
                }
            }
        } catch {
            // Fall through to write; permission handling below will surface real failures.
        }
        await this.writeWithPermission(CUSTOM_JS_FILE_PATH, js);
        return true;
    }

    private async saveWallpaperSceneRuntimeContent(): Promise<void> {
        const inputs = await loadWallpaperSceneInputs(getContext().extensionPath);
        if (!this.wallpaperPkgSourcePath) {
            throw new Error('Wallpaper Engine scene package source path is unavailable.');
        }
        if (IS_CODE_SERVER_TARGET) {
            this.wallpaperSceneUrl = this.imagePath;
        } else {
            await validateWallpaperPkgFile(this.wallpaperPkgSourcePath);
            const packageAssetPath = await copyWallpaperScenePackage(this.wallpaperPkgSourcePath, CUSTOM_ASSET_DIR);
            this.wallpaperSceneUrl = Uri.file(packageAssetPath)
                .with({ scheme: 'vscode-file', authority: 'vscode-app' })
                .toString();
        }
        await this.writeGeneratedTextFile(
            CUSTOM_SCENE_HTML_FILE_PATH,
            buildWallpaperSceneHtml(inputs.template, inputs.runtime, inputs.sceneScript)
        );
    }

    private async writeGeneratedTextFile(filePath: string, content: string): Promise<void> {
        let current: string | undefined;
        try {
            current = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            // Write missing or unreadable generated assets.
        }
        if (current !== content) {
            await this.writeWithPermission(filePath, content);
        }
    }

    // code-server 静态资源会被浏览器长缓存，给 workbench.js URL 增加版本参数以确保首次注入后能加载新文件。
    private async saveCodeServerHtmlContent(cacheKey: string): Promise<boolean> {
        if (!IS_CODE_SERVER_TARGET || !HTML_FILE_PATH || !(await fse.pathExists(HTML_FILE_PATH))) {
            return false;
        }

        const content = await this.getContent(HTML_FILE_PATH);
        const patchedContent = patchCodeServerWorkbenchHtml(content, cacheKey);

        if (patchedContent === content) {
            return false;
        }

        await this.writeWithPermission(HTML_FILE_PATH, patchedContent);
        return true;
    }

    private async clearCodeServerHtmlContent(): Promise<void> {
        if (!IS_CODE_SERVER_TARGET || !HTML_FILE_PATH || !(await fse.pathExists(HTML_FILE_PATH))) {
            return;
        }

        const content = await this.getContent(HTML_FILE_PATH);
        const patchedContent = clearCodeServerWorkbenchHtmlPatch(content);

        if (patchedContent !== content) {
            await this.writeWithPermission(HTML_FILE_PATH, patchedContent);
        }
    }

    // 获取要应用的js内容
    private getJs(): string {
        return `
        /*ext-${this.extName}-start*/
        /*ext.${this.extName}.bootstrap.${BOOTSTRAP_VERSION}*/
        ${this.getBootstrapJs()}
        /*ext-${this.extName}-end*/
        `;
    }

    private getDynamicJs(): string {
        return `
        /*ext.${this.extName}.ver.${version}*/
        ${this.getLoaderJs()}
        `;
    }

    private getBootstrapJs(): string {
        const jsDesktopUrl = Uri.file(CUSTOM_JS_FILE_PATH).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
        const escapedDesktopUrl = this.escapeTemplateLiteral(jsDesktopUrl);
        const webJsPath = WEB_RELATIVE_JS_PATH ? this.escapeTemplateLiteral(WEB_RELATIVE_JS_PATH) : '';
        const jsFileName = this.escapeTemplateLiteral(CUSTOM_JS_FILE_NAME);
        const workbenchJsName = this.escapeTemplateLiteral(selectedWorkbench.js);

        return `
        (function() {
            const dynamicDesktopUrl = '${escapedDesktopUrl}';
            const relativeDynamicPath = '${webJsPath}';
            const dynamicFileName = '${jsFileName}';
            const workbenchJsName = '${workbenchJsName}';
            const GLOBAL_KEY = '__wallpaperStudioDynamicLoader';

            function withCacheBust(url) {
                const sep = url.indexOf('?') === -1 ? '?' : '&';
                return url + sep + 't=' + Date.now();
            }

            function deriveFromScript() {
                if (typeof document === 'undefined') {
                    return undefined;
                }

                const buildFromSrc = (src) => {
                    try {
                        return new URL(dynamicFileName, src).toString();
                    } catch (error) {
                        console.error('[WallpaperStudio] Dynamic script URL resolve error:', error);
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

            function resolveDynamicUrl() {
                const scriptResolved = deriveFromScript();
                if (scriptResolved) {
                    return scriptResolved;
                }

                if (relativeDynamicPath) {
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
                            return new URL(relativeDynamicPath, base).toString();
                        } catch (error) {
                            console.error('[WallpaperStudio] Dynamic base URL failed:', error);
                        }
                    }

                    if (!relativeDynamicPath.startsWith('http')) {
                        try {
                            return new URL(relativeDynamicPath, '/').toString();
                        } catch (error) {
                            console.error('[WallpaperStudio] Dynamic relative URL failed:', error);
                        }
                    }
                }

                return dynamicDesktopUrl;
            }

            function disposePreviousDynamicJs() {
                try {
                    const previous = window[GLOBAL_KEY];
                    if (previous && typeof previous.dispose === 'function') {
                        previous.dispose();
                    }
                } catch (error) {
                    console.error('[WallpaperStudio] Dynamic dispose failed:', error);
                }
            }

            const dynamicUrl = resolveDynamicUrl();
            // Workbench CSP enforces require-trusted-types-for 'script' with no
            // 'default' policy, so assigning a string to script.src throws.
            // Dynamic import() is not a Trusted Types sink and script-src 'self'
            // permits loading the sibling file, so load the module instead.
            let loadGeneration = 0;
            // 加载器文件可能比内核补丁晚一步生成（扩展刚升级 / 清理过产物时，
            // 补丁还在但 js 要等扩展下一次应用背景才写回来）。原先只重试 3 次、
            // 每次间隔 1 秒，窗口启动早于文件生成就会彻底失败，表现为
            // 「面板预览正常、背景一片空白」且必须手动重载窗口。
            // 现在改成约 40 秒的指数退避，并在窗口聚焦 / 可见时再补一次。
            const LOAD_RETRY_DELAYS = [400, 800, 1500, 2500, 4000, 6000, 9000, 15000];
            function loadDynamicJs() {
                const generation = ++loadGeneration;
                disposePreviousDynamicJs();

                const attemptLoad = (attempt) => {
                    if (generation !== loadGeneration) {
                        return;
                    }
                    try {
                        import(withCacheBust(dynamicUrl)).catch((error) => {
                            console.error('[WallpaperStudio] Dynamic load error:', error);
                            const delay = LOAD_RETRY_DELAYS[attempt];
                            if (generation !== loadGeneration || delay === undefined) {
                                return;
                            }
                            setTimeout(() => attemptLoad(attempt + 1), delay);
                        });
                    } catch (error) {
                        console.error('[WallpaperStudio] Dynamic import failed:', error);
                    }
                };
                attemptLoad(0);
            }

            // 用户切回窗口时兜底：退避序列用尽后仍失败的情况（例如扩展装了很久才写入
            // 加载器）在这里补一次，不用让用户自己想到去重载窗口。
            let focusRetryBound = false;
            function bindFocusRetry() {
                if (focusRetryBound || typeof window === 'undefined' || !window.addEventListener) {
                    return;
                }
                focusRetryBound = true;
                window.addEventListener('focus', () => {
                    if (!window[GLOBAL_KEY]) { loadDynamicJs(); }
                });
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden && !window[GLOBAL_KEY]) { loadDynamicJs(); }
                });
            }

            window.__wallpaperStudioBootstrap = { reload: loadDynamicJs };
            bindFocusRetry();
            loadDynamicJs();
        })();
        `;
    }
    // 获取css内容
    private getCss(): string {
        const opacity = Math.min(this.imageOpacity, 0.8);
        const { sizeModelVal, repeatVal, positionVal } = this.getCssStyles();

        let rawPath = this.imagePath;
        const globalWindow = typeof globalThis !== 'undefined' ? (globalThis as any).window : undefined;
        
        if (this.forceHttpsUpgrade && rawPath.toLowerCase().startsWith('http://')) {
            if (globalWindow?.location?.protocol === 'https:') {
                rawPath = rawPath.replace(/^http:\/\//i, 'https://');
            }
        }

        let cssPath = this.escapeTemplateLiteral(rawPath);

        if (this.isWallpaperPkg) {
            const config = createSceneRenderConfig({
                url: this.wallpaperSceneUrl || rawPath,
                title: path.basename(this.wallpaperPkgSourcePath || rawPath),
                properties: getWallpaperPropertyOverrides(getContext().globalState, this.wallpaperPkgSourcePath || rawPath),
                // 没有这份声明，引擎就不会把 setProperties() 的值绑回 scene.json，
                // 用户改配置时画面不会变（只能改脚本里的变量）。
                project: getWallpaperProjectDeclaration(this.wallpaperPkgSourcePath || rawPath),
                opacity: opacity,
                blur: this.blur,
                blendMode: resolveBlendModeValue(this.blendModel)
            });
            const jsonConfig = JSON.stringify(config)
                .replace(/`/g, '\\`')
                .replace(/\$\{/g, '\\${');
            return `
            /*wallpaper-studio-scene-start*/
            ${jsonConfig}
            /*wallpaper-studio-scene-end*/
            ${resolveThemeBlendRules(this.blendModel)}
            ${getCorruptionWarningCss()}
            `;
        }

        if (this.isVideo) {
            const config = {
                url: rawPath,
                opacity: opacity,
                blur: this.blur,
                // A4: auto 模式注入 CSS 变量，主题切换由 :has() 即时适配
                blendMode: resolveBlendModeValue(this.blendModel),
                // A6: 视频元素同样支持淡入淡出（loader 的 applyVideo 读取该字段）
                transition: this.transitionEnabled
            };
            // Escape backticks and ${} for template literal safety, but keep backslashes as is (JSON stringified)
            const jsonConfig = JSON.stringify(config)
                .replace(/`/g, '\\`')
                .replace(/\$\{/g, '\\${');

            return `
            /*wallpaper-studio-video-start*/
            ${jsonConfig}
            /*wallpaper-studio-video-end*/
            ${resolveThemeBlendRules(this.blendModel)}
            ${getCorruptionWarningCss()}
            `;
        }

        return `
        body::before{
            content: "";
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            position: absolute;
            background-size: ${sizeModelVal};
            background-repeat: ${repeatVal};
            background-position: ${positionVal};
            opacity:${opacity};
            background-image:url('${cssPath}');
            z-index: 2;
            pointer-events: none;
            filter: blur(${this.blur}px);
            ${resolveBlendModeDeclaration(this.blendModel)}
            ${getTransitionDeclaration(this.transitionEnabled)}
        }
        ${resolveThemeBlendRules(this.blendModel)}
        ${getTransitionReducedMotionCss(this.transitionEnabled)}
        ${getCorruptionWarningCss()}
        `;
    }
    // 获取js内容
    private getLoaderJs(): string {
        const cssDesktopUrl = Uri.file(CUSTOM_CSS_FILE_PATH).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
        const escapedDesktopUrl = this.escapeTemplateLiteral(cssDesktopUrl);
        const webCssPath = WEB_RELATIVE_CSS_PATH ? this.escapeTemplateLiteral(WEB_RELATIVE_CSS_PATH) : '';
        const cssFileName = this.escapeTemplateLiteral(CUSTOM_CSS_FILE_NAME);
        const workbenchJsName = this.escapeTemplateLiteral(selectedWorkbench.js);
        const relativePlaceholder = this.escapeTemplateLiteral(RELATIVE_URL_PLACEHOLDER);

        const videoSetup = `
            function applyVideo(targetWindow, config) {
                try {
                    const doc = targetWindow && targetWindow.document;
                    if (!doc || !doc.body) return;
                    let video = doc.getElementById('wallpaper-studio-video');
                    if (!config) {
                        if (video) {
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

                    video.style.opacity = config.opacity + '';
                    video.style.filter = 'blur(' + config.blur + 'px)';
                    video.style.mixBlendMode = config.blendMode;

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
                    try {
                        const windows = [window].concat(Array.from(window.__wallpaperStudioAuxWindows || []));
                        windows.forEach(targetWindow => disposeScene(targetWindow, true));
                    } catch (e) {
                        console.error('[WallpaperStudio] Scene dispose failed:', e);
                    }
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
            const perWindowEnabled = ${isPerWindowEnabled()};

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

            function cssUrlForToken(token) {
                // 'shared' = 共用模式：回到不带 session 后缀的共享 CSS。
                if (!token || token === '${SHARED_CSS_TOKEN}') return cssUrl;
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
                return window.__wallpaperStudioCssUrl || cssUrl;
            }
            
            ${videoSetup}

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
                return url.toString();
            })();

            function disposeScene(targetWindow, removeFrame) {
                const state = targetWindow && targetWindow.__wallpaperStudioSceneState;
                if (!state) return;
                state.generation++;
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
                targetWindow.fetch(state.config.url, { cache: 'no-store' }).then(function(response) {
                    if (!response.ok) throw new Error('Scene package fetch failed: ' + response.status);
                    return response.arrayBuffer();
                }).then(function(buffer) {
                    if (targetWindow.__wallpaperStudioSceneState !== state || state.generation !== generation) return;
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
                            properties: properties
                        }, '*', [buffer]);
                    } catch (error) {
                        state.loading = false;
                        console.error('[WallpaperStudio] Scene load message failed:', error);
                    }
                }).catch(function(error) {
                    if (targetWindow.__wallpaperStudioSceneState === state && state.generation === generation) {
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
                                state.loading = false;
                                state.ready = true;
                            } else if (message.type === 'scene-error') {
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
                    }

                    state.frame.title = config.title || 'Wallpaper Engine scene';
                    state.frame.style.opacity = String(config.opacity);
                    state.frame.style.filter = 'blur(' + config.blur + 'px)';
                    state.frame.style.mixBlendMode = config.blendMode;
                    if (state.url === config.url && (state.loading || state.ready)) {
                        // 记住最新配置，后续 applyToAll（窗口增删/主题切换）要用新值重建。
                        state.config = config;
                        if (state.ready && state.frame && state.frame.contentWindow) {
                            state.frame.contentWindow.postMessage({
                                type: 'set-properties',
                                properties: config.properties || {}
                            }, '*');
                        }
                        return;
                    }

                    disposeScene(targetWindow, false);
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

            function loadCss() {
                // 拖动滑块时会有连续的变更通知：正在读的时候不能直接丢弃，
                // 否则最后一次改动（用户实际停下的位置）可能永远不生效。
                if (cssLoadInFlight) {
                    cssReloadPending = true;
                    return;
                }
                cssLoadInFlight = true;
                lastCssLoadAt = Date.now();
                const currentCssUrl = activeCssUrl();
                const url = withCacheBust(currentCssUrl);
                fetch(url).then(r => r.text()).then(css => {
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

                    // A5: 换图前先预加载目标图片，避免首帧闪烁（最长等待 2s）
                    return preloadBackgroundImage(resolvedCss);
                }).then(() => {
                    applyToAll();
                }).catch(e => console.error('[WallpaperStudio] Load error:', e))
                .finally(() => {
                    cssLoadInFlight = false;
                    if (cssReloadPending) {
                        cssReloadPending = false;
                        loadCss();
                    }
                });
            }

            function scheduleLoadCss(reason, delay) {
                registerTimer(setTimeout(() => {
                    try {
                        loadCss();
                    } catch (e) {
                        console.error('[WallpaperStudio] Scheduled load error (' + reason + '):', e);
                    }
                }, delay || 0));
            }

            // Initial load
            scheduleLoadCss('initial', 0);

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
                                scheduleLoadCss('statusbar', 0);
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

    // 获取css样式值
    private getCssStyles(): { sizeModelVal: string; repeatVal: string; positionVal: string } {
        let sizeModelVal = this.sizeModel;
        let repeatVal = "no-repeat";
        let positionVal = "center";

        switch (this.sizeModel) {
            case "cover":
                sizeModelVal = "cover";
                break;
            case "contain":
                sizeModelVal = "100% 100%";
                break;
            case "center":
                sizeModelVal = "contain";
                break;
            case "repeat":
                sizeModelVal = "auto";
                repeatVal = "repeat";
                break;
            case "not_center":
                sizeModelVal = "auto";
                break;
            case "not_right_bottom":
                sizeModelVal = "auto";
                positionVal = "right 96%";
                break;
            case "not_right_top":
                sizeModelVal = "auto";
                positionVal = "right 30px";
                break;
            case "not_left":
                sizeModelVal = "auto";
                positionVal = "left";
                break;
            case "not_right":
                sizeModelVal = "auto";
                positionVal = "right";
                break;
            case "not_top":
                sizeModelVal = "auto";
                positionVal = "top";
                break;
            case "not_bottom":
                sizeModelVal = "auto";
                positionVal = "bottom";
                break;
        }

        return { sizeModelVal, repeatVal, positionVal };
    }

    // 转义模板字符串
    private escapeTemplateLiteral(value: string): string {
        if (!value) return value;
        return value
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
    }

    // 图片转为Base64
    private async imageToBase64(): Promise<boolean> {
        try {
            const extname = path.extname(this.imagePath).substr(1);
            const imageBuffer = await fs.promises.readFile(path.resolve(this.imagePath));
            this.imagePath = `data:image/${extname};base64,${imageBuffer.toString('base64')}`;
            return true;
        } catch {
            return false;
        }
    }

    private async prepareCodeServerAsset(sourcePath: string): Promise<string | undefined> {
        try {
            await fse.ensureDir(CUSTOM_ASSET_DIR);
            const buffer = await fse.readFile(path.resolve(sourcePath));
            const hash = crypto.createHash('md5').update(buffer).digest('hex');
            const ext = path.extname(sourcePath) || '.img';
            const fileName = `${hash}${ext}`;
            const destPath = path.join(CUSTOM_ASSET_DIR, fileName);

            if (!(await fse.pathExists(destPath))) {
                await fse.writeFile(destPath, buffer);
            }

            const relativeUrl = this.getRelativeAssetUrl(destPath);
            if (!relativeUrl) {
                return undefined;
            }

            const normalized = relativeUrl.replace(/^\/+/, '');
            return `${RELATIVE_URL_PLACEHOLDER}/${normalized}`;
        } catch (error) {
            console.error('[FileDom] Failed to prepare code-server asset:', error);
            return undefined;
        }
    }
    private getRelativeAssetUrl(targetPath: string): string | undefined {
        try {
            const relative = path.relative(selectedWorkbench.root, targetPath);
            if (!relative || relative.startsWith('..')) {
                return undefined;
            }
            return relative.split(path.sep).join('/');
        } catch (error) {
            console.error('[FileDom] Failed to resolve asset url:', error);
            return undefined;
        }
    }

    private localImgToVsc(): void {
        // 使用 Uri.file 自动处理路径分隔符和编码，避免手动拼接导致的路径错误（如 macOS 下的双斜杠问题）
        this.imagePath = Uri.file(this.imagePath).with({ scheme: 'vscode-file', authority: 'vscode-app' }).toString();
    }

    private clearCssContent(content: string): string {
        return clearPatchBlock(content);
    }

    public getPatchContent(content: string): boolean {
        return hasPatchBlock(content);
    }
}

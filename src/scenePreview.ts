import * as fs from 'fs';
import * as path from 'path';
import { buildWallpaperScenePage } from './wallpaperScene';
import { CACHE_ROOT } from './cachePaths';
import { atomicWriteTextSync } from './atomicWrite';
import { acquireFileLock } from './cancellation';

/**
 * Studio 面板里的场景包预览需要一个能跑的 WebWallGL 页面。
 *
 * workbench 里那份 `wallpaper-studio-scene.html` 走 `vscode-file:`，webview 加载
 * 不了；这里把同一份内容（同模板 + 同运行时，只是同一份 HTML）写到扩展的
 * 用户统一缓存目录下，用 `webview.asWebviewUri` 直接当 iframe 源。好处是预览
 * 完全不依赖补丁是否已应用，且渲染链路与真实背景完全一致。
 */
export const SCENE_PREVIEW_FILE_NAME = 'wallpaper-studio-scene.html';
const SCENE_PREVIEW_DIR = 'scene-preview';
const SCENE_PREVIEW_STAMP_FILE = 'wallpaper-studio-scene.stamp';

/** 同一进程内只生成一次；键为 globalStorage 路径。 */
let ensured: { dir: string; file: string; stamp: string } | undefined;

export interface ScenePreviewPage {
    filePath: string;
    /** 重新生成时返回 true，调用方据此决定是否重置 webview 里的 iframe。 */
    regenerated: boolean;
}

/**
 * 确保场景预览页存在且与当前扩展资源一致，返回文件路径（不生成 webview URI，
 * 由调用方用 `asWebviewUri` 转换）。
 */
export async function ensureWallpaperScenePreviewPage(
    extensionPath: string,
    cacheRoot = CACHE_ROOT
): Promise<ScenePreviewPage> {
    const dir = path.join(cacheRoot, SCENE_PREVIEW_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    const release = await acquireFileLock(dir);
    try {
    const filePath = path.join(dir, SCENE_PREVIEW_FILE_NAME);
    const cached = ensured;
    if (cached && cached.dir === dir && fs.existsSync(cached.file) && readStamp(cached.file) === cached.stamp) {
        return { filePath: cached.file, regenerated: false };
    }

    const { html, stamp } = await buildWallpaperScenePage(extensionPath);
    if (fs.existsSync(filePath) && readStamp(filePath) === stamp) {
        ensured = { dir, file: filePath, stamp };
        return { filePath, regenerated: false };
    }

    await fs.promises.mkdir(dir, { recursive: true });
    atomicWriteTextSync(filePath, html);
    atomicWriteTextSync(path.join(dir, SCENE_PREVIEW_STAMP_FILE), stamp);
    ensured = { dir, file: filePath, stamp };
    return { filePath, regenerated: true };
    } finally { await release(); }
}

export async function clearWallpaperScenePreview(): Promise<void> {
    const dir = path.join(CACHE_ROOT, SCENE_PREVIEW_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    const release = await acquireFileLock(dir);
    try {
        ensured = undefined;
        for (const name of await fs.promises.readdir(dir)) {
            if ([SCENE_PREVIEW_FILE_NAME, SCENE_PREVIEW_STAMP_FILE].includes(name) || /^wallpaper-studio-scene\.(?:html|stamp)\..+\.tmp$/.test(name)) {
                await fs.promises.unlink(path.join(dir, name));
            }
        }
    } finally { await release(); }
}

/** 记录在独立 stamp 文件里，避免改动 HTML 正文结构。 */
function readStamp(filePath: string): string | undefined {
    try {
        return fs.readFileSync(path.join(path.dirname(filePath), SCENE_PREVIEW_STAMP_FILE), 'utf8').trim();
    } catch {
        return undefined;
    }
}

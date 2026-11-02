import * as fs from 'fs';
import * as path from 'path';
import {
    DEFAULT_WALLPAPER_CONFIG,
    WALLPAPER_USER_KEY,
    hasWallpaperConfig,
    readRemovedWallpapers,
    readWallpaperPlaylist,
    resolveActiveWallpaperUser
} from './wallpaperEngine';
import { getContext } from './global';
import { getAppConfig } from './settingsStore';
import { expandPathVariables } from './pathUtil';
import { isPathInsideFolder, samePath } from './pathComparison';

/**
 * 来源模式：三种模式互斥。
 *
 * 以前"当前是什么模式"有两套判定：
 *   - 面板侧看 `wallpaperStudioSourceMode`；
 *   - `PickList` 的自动轮播 / 随机命令只看 `wallpaperStudioWallpaperEnabled`，
 *     而且两个模块读取该键的默认值还不一样（true / false）。
 * 结果就是**随机和定时轮播会跑到别的模式里挑壁纸**：
 * 比如当前是 Wallpaper 配置模式，定时器却从 `randomImageFolder` 里抽图。
 *
 * 现在统一以 `wallpaperStudioSourceMode` 为唯一真源，所有挑选入口都走
 * `getCandidatesForMode()`，保证随机 / 上一张 / 列表永远只在本模式内。
 */

export type SourceMode = 'file' | 'folder' | 'wallpaper';

export const DEFAULT_SOURCE_MODE: SourceMode = 'wallpaper';

export function normalizeSourceMode(value: unknown): SourceMode {
    return value === 'file' || value === 'folder' || value === 'wallpaper'
        ? value
        : DEFAULT_SOURCE_MODE;
}

/** 当前来源模式（唯一真源）。 */
export function getSourceMode(): SourceMode {
    try {
        return normalizeSourceMode(getContext().globalState.get<string>('wallpaperStudioSourceMode'));
    } catch {
        return DEFAULT_SOURCE_MODE;
    }
}

export async function setSourceMode(mode: SourceMode): Promise<void> {
    const context = getContext();
    await context.globalState.update('wallpaperStudioSourceMode', mode);
    // 历史键只保留"是否启用 Wallpaper 配置"，与模式保持同步，避免两边打架。
    await context.globalState.update('wallpaperStudioWallpaperEnabled', mode === 'wallpaper');
}

/** 当前模式是否是「Wallpaper 配置」且配置文件可用。 */
export function isWallpaperModeActive(): boolean {
    if (getSourceMode() !== 'wallpaper') { return false; }
    try {
        const configPath = getContext().globalState.get<string>(
            'wallpaperStudioWallpaperConfig',
            DEFAULT_WALLPAPER_CONFIG
        );
        return hasWallpaperConfig(configPath);
    } catch {
        return false;
    }
}

function currentFolder(): string {
    try {
        return expandPathVariables(getAppConfig().get<string>('randomImageFolder') || '');
    } catch {
        return '';
    }
}

/** Wallpaper 播放列表里可用的项目（只取当前用户 + 过滤已移除的）。 */
export function getWallpaperCandidates(): string[] {
    try {
        const context = getContext();
        const configPath = context.globalState.get<string>(
            'wallpaperStudioWallpaperConfig',
            DEFAULT_WALLPAPER_CONFIG
        );
        if (!hasWallpaperConfig(configPath)) { return []; }
        const active = resolveActiveWallpaperUser(
            configPath,
            context.globalState.get<string>(WALLPAPER_USER_KEY, '')
        );
        return readWallpaperPlaylist(
            configPath,
            readRemovedWallpapers(context.globalState),
            active?.user
        )
            .filter(entry => entry.active && fs.existsSync(entry.path))
            .map(entry => entry.path);
    } catch {
        return [];
    }
}

/** 目录媒体候选：目录内未被移除的文件。 */
export function getFolderCandidates(): string[] {
    const folder = currentFolder();
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) { return []; }
    try {
        const removed = getContext().globalState.get<string[]>('wallpaperStudioFolderRemoved', []) || [];
        return fs.readdirSync(folder)
            .filter(name => /\.(svg|png|jpe?g|gif|bmp|webp|jfif|mp4|webm|ogg|mov|pkg)$/i.test(name))
            .map(name => path.join(folder, name))
            .filter(full => !removed.some(item => samePath(item, full)));
    } catch {
        return [];
    }
}

/**
 * 本地文件候选：最近使用列表里的条目，**严格**排除其它模式的成员。
 *
 * 排除两类：
 *   1. Wallpaper 播放列表里的项目；
 *   2. 当前目录媒体目录内的文件。
 *
 * 过滤后为空就返回空 —— 这里不再"兜底回退到包含目录文件的列表"。
 * 那个兜底会让本地文件模式重新抽到目录媒体里的壁纸，等于隔离失效；
 * 候选为空时上层会提示用户"请先选择壁纸"，语义更明确。
 */
export function getFileCandidates(): string[] {
    let recent: string[] = [];
    try {
        recent = getContext().globalState.get<string[]>('wallpaperStudioRecentImages', []) || [];
    } catch {
        recent = [];
    }
    const wallpaperPaths = getWallpaperCandidates();
    const withoutPlaylist = recent.filter(
        item => !wallpaperPaths.some(candidate => samePath(candidate, item))
    );
    const folder = currentFolder();
    if (!folder) { return withoutPlaylist; }
    return withoutPlaylist.filter(item => !isPathInsideFolder(item, folder));
}

/** 指定模式下的可随机候选。 */
export function getCandidatesForMode(mode: SourceMode = getSourceMode()): string[] {
    if (mode === 'wallpaper') { return getWallpaperCandidates(); }
    if (mode === 'folder') { return getFolderCandidates(); }
    return getFileCandidates();
}

/**
 * 当前模式下**除当前壁纸之外**的候选（随机换一张用）。
 *
 * 只有一张时返回空数组：调用方据此提示"当前模式没有其它壁纸可用"。
 * 之前这里回退成全集，会把当前这张又随机一次，用户看到的是"点了没反应"。
 */
export function getRandomCandidates(current?: string): string[] {
    const all = getCandidatesForMode();
    if (!current) { return all; }
    return all.filter(item => !samePath(item, current));
}

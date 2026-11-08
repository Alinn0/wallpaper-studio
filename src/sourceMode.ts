import * as fs from 'fs';
import { mutateState } from './stateMutation';
import * as path from 'path';
import {
    DEFAULT_WALLPAPER_CONFIG,
    WALLPAPER_USER_KEY,
    hasWallpaperConfig,
    readCachedWallpaperPlaylist,
    readRemovedWallpapers,
    readWallpaperPlaylist,
    resolveActiveWallpaperUser
} from './wallpaperEngine';
import { getContext } from './global';
import { getAppConfig } from './settingsStore';
import { expandPathVariables, isSupportedMedia } from './pathUtil';
import { normalizeComparablePath, samePath } from './pathComparison';

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

export async function setSourceMode(mode: SourceMode, shouldPersist: () => boolean = () => true): Promise<void> {
    const context = getContext();
    await mutateState(context.globalState, 'wallpaperStudioSourceMode', DEFAULT_SOURCE_MODE,
        current => shouldPersist() ? mode : current);
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
        const removed = readRemovedWallpapers(context.globalState);
        // 面板加载过完整列表就直接用缓存，避免为了拿候选路径再同步解析一遍。
        const entries = readCachedWallpaperPlaylist(configPath, removed, active?.user)
            ?? readWallpaperPlaylist(configPath, removed, active?.user);
        return entries
            .filter(entry => entry.active && fs.existsSync(entry.path))
            .map(entry => entry.path);
    } catch {
        return [];
    }
}

/** 目录媒体候选：目录内未被移除的文件。 */
export function getFolderCandidates(): string[] {
    const folder = currentFolder();
    try {
        if (!folder || !fs.statSync(folder).isDirectory()) { return []; }
        const removed = getContext().globalState.get<string[]>('wallpaperStudioFolderRemoved', []) || [];
        return fs.readdirSync(folder, { withFileTypes: true })
            .filter(entry => entry.isFile() && isSupportedMedia(entry.name))
            .map(entry => path.join(folder, entry.name))
            .filter(full => !removed.some(item => samePath(item, full)));
    } catch {
        return [];
    }
}

/** Explicitly imported files form a library, never a playback history. */
export const LOCAL_FILES_KEY = 'wallpaperStudioLocalFiles';

export function getLocalFiles(): string[] {
    const stored = getContext().globalState.get<unknown>(LOCAL_FILES_KEY, []);
    if (!Array.isArray(stored)) { return []; }
    const seen = new Set<string>();
    return stored.filter((item): item is string => {
        if (typeof item !== 'string' || !item) { return false; }
        const key = normalizeComparablePath(item);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

export async function addLocalFiles(files: string[]): Promise<void> {
    await mutateState(getContext().globalState, LOCAL_FILES_KEY, [] as string[], entries => {
        for (const file of files) {
            if (file && isSupportedMedia(file) && !entries.some(item => samePath(item, file))) { entries.push(file); }
        }
        return entries;
    });
}

export async function removeLocalFile(file: string): Promise<void> {
    await mutateState(getContext().globalState, LOCAL_FILES_KEY, [] as string[], entries => entries.filter(item => !samePath(item, file)));
}

export function getFileCandidates(): string[] {
    return getLocalFiles().filter(item => {
        try { return isSupportedMedia(item) && fs.statSync(item).isFile(); } catch { return false; }
    });
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

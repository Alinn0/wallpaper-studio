import * as crypto from 'crypto';
import * as path from 'path';
import { ConfigurationTarget, env, workspace, WorkspaceConfiguration } from 'vscode';
import { onDidChangeGlobalState } from './global';
import { getAppConfig } from './settingsStore';
import { readRuntimeState, updateRuntimeState } from './runtimeStore';
import { normalizeComparablePath } from './pathComparison';

const NO_WORKSPACE_KEY = 'no-workspace';

// Limit retained workspace records; transient overrides remain in this host only.
const MAX_WORKSPACE_RECORDS = 40;
let volatileImagePath: string | undefined;

/**
 * 关掉后回到旧版行为：所有窗口共用一张背景图、共用一份 CSS 文件。
 * 每次读取而不缓存，配置改动后无需重启窗口即可生效。
 */
export function isPerWindowEnabled(): boolean {
    try {
        return getAppConfig().get<boolean>('perWindowBackground', true);
    } catch {
        return true;
    }
}

function shortHash(input: string): string {
    return crypto.createHash('md5').update(input).digest('hex').slice(0, 8);
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(target, key);
}

export function getSessionHash(): string {
    return shortHash(env.sessionId || 'default-session');
}

export function getWorkspaceKey(): string | undefined {
    const folder = workspace.workspaceFolders && workspace.workspaceFolders[0];
    if (!folder) {
        return NO_WORKSPACE_KEY;
    }

    let normalized = normalizeComparablePath(folder.uri.fsPath).replace(/\\+/g, '/').replace(/\/+$/, '');
    if (folder.uri.scheme && folder.uri.scheme !== 'file') {
        normalized = `${folder.uri.scheme}://${folder.uri.authority || ''}/${normalized}`;
    }
    return shortHash(normalized);
}

/** Register the current folder even before it has a wallpaper selection. */
export async function ensureWorkspaceRecord(): Promise<void> {
    const folder = workspace.workspaceFolders && workspace.workspaceFolders[0];
    const key = getWorkspaceKey();
    if (!folder || !key) { return; }
    const folderPath = path.normalize(folder.uri.fsPath);
    await updateRuntimeState(runtime => {
        if (runtime.workspacePaths[key] !== folderPath) {
            runtime.workspacePaths[key] = folderPath;
        }
    });
}

export function getWindowCssFileName(): string {
    return `css-wallpaper-studio.${getWorkspaceCssToken()}.css`;
}

/** CSS is shared by windows in the same folder and isolated across folders. */
export function getWorkspaceCssToken(): string {
    const workspaceKey = getWorkspaceKey();
    return workspaceKey === NO_WORKSPACE_KEY ? 'noworkspace' : (workspaceKey || 'noworkspace');
}

function readImageMap(): Record<string, string> {
    const runtime = readRuntimeState();
    return { ...runtime.workspaceImages };
}

export function hasCurrentImageRecord(): boolean {
    if (volatileImagePath !== undefined) {
        return true;
    }
    const workspaceKey = getWorkspaceKey();
    if (workspaceKey) {
        const workspaceMap = readImageMap();
        if (hasOwn(workspaceMap, workspaceKey)) {
            return true;
        }
    }
    return false;
}

/**
 * 当前"持久化"的背景图：window → workspace → global → settings 兜底。
 * 与 resolveCurrentImagePath 的区别是刻意忽略 volatile 内存态（定时自动换图
 * 只写内存的临时图），供判断"在线单图源记录是否仍是当前背景"这类场景使用。
 */
export function getPersistedCurrentImage(globalFallback?: string): string {
    const workspaceKey = getWorkspaceKey();
    if (workspaceKey) {
        const workspaceMap = readImageMap();
        if (hasOwn(workspaceMap, workspaceKey)) {
            return workspaceMap[workspaceKey] || '';
        }
    }
    return '';
}

export function resolveCurrentImagePath(globalFallback?: string): string {
    if (volatileImagePath !== undefined) {
        return volatileImagePath;
    }
    return getPersistedCurrentImage(globalFallback);
}

export function getPreviousImagePath(): string {
    return readRuntimeState().workspacePreviousImages[getWorkspaceKey() || NO_WORKSPACE_KEY] || '';
}

export function getStagedImagePath(): string {
    return readRuntimeState().workspaceStagedImages[getWorkspaceKey() || NO_WORKSPACE_KEY] || '';
}

export async function setStagedImagePath(imagePath: string, shouldPersist: () => boolean = () => true): Promise<void> {
    const key = getWorkspaceKey() || NO_WORKSPACE_KEY;
    const saved = await updateRuntimeState(runtime => {
        if (!shouldPersist()) { return; }
        if (imagePath) { runtime.workspaceStagedImages[key] = imagePath; runtime.workspaceStagedImages = pruneRecords(runtime.workspaceStagedImages, key); }
        else { delete runtime.workspaceStagedImages[key]; }
    });
    if (!saved) { throw Error('Failed to save staged wallpaper'); }
}

/** Pins share the same workspace lifetime as the current background. */
export function getPinnedImagePath(): string {
    const runtime = readRuntimeState();
    const key = getWorkspaceKey() || NO_WORKSPACE_KEY;
    const pinned = runtime.workspacePinnedImages[key] || '';
    return pinned && normalizeComparablePath(pinned) === normalizeComparablePath(runtime.workspaceImages[key] || '')
        ? pinned : '';
}

export async function clearPinnedImagePath(expectedPath: string, shouldPersist: () => boolean): Promise<void> {
    const key = getWorkspaceKey() || NO_WORKSPACE_KEY;
    const saved = await updateRuntimeState(runtime => {
        if (shouldPersist() && normalizeComparablePath(runtime.workspacePinnedImages[key] || '') === normalizeComparablePath(expectedPath)) {
            delete runtime.workspacePinnedImages[key];
        }
    });
    if (!saved) { throw new Error('Failed to save wallpaper pin'); }
    onDidChangeGlobalState.fire();
}

export interface SetImageOptions {
    /** false 表示只更新当前窗口的内存态，不写入 runtime.json。 */
    persist?: boolean;
    workspaceKey?: string;
    shouldPersist?: () => boolean;
    /** Set/clear pin with the successful background change. */
    pin?: boolean;
}

/**
 * 把值按当前打开的文件夹写入 runtime.json。无工作区时使用固定的
 * no-workspace 键；同一文件夹的多个 VS Code 窗口因此共享同一张壁纸。
 */
async function persistWorkspaceImage(
    value: string,
    options: SetImageOptions = {}
): Promise<void> {
    const workspaceHash = options.workspaceKey ?? getWorkspaceKey();
    let committed = false;
    const saved = await updateRuntimeState(runtime => {
        if (options.shouldPersist && !options.shouldPersist()) { return; }
        const workspaceMap = runtime.workspaceImages;
        if (workspaceHash) {
            committed = true;
            delete runtime.workspaceStagedImages[workspaceHash];
            const previous = runtime.workspaceImages[workspaceHash] || '';
            const next = String(value);
            const changed = normalizeComparablePath(previous) !== normalizeComparablePath(next);
            if (changed && previous) { runtime.workspacePreviousImages[workspaceHash] = previous; }
            if (options.pin && next) { runtime.workspacePinnedImages[workspaceHash] = next; }
            else if (changed || options.pin === false || !next) { delete runtime.workspacePinnedImages[workspaceHash]; }
            delete workspaceMap[workspaceHash];
            workspaceMap[workspaceHash] = value;
            const prunedWorkspaceMap = pruneRecords(workspaceMap, workspaceHash);
            Object.keys(workspaceMap).forEach(key => {
                if (!(key in prunedWorkspaceMap)) {
                    delete workspaceMap[key];
                    delete runtime.workspacePreviousImages[key];
                    delete runtime.workspacePinnedImages[key];
                    delete runtime.workspaceStagedImages[key];
                }
            });
        }
    });
    if (!saved) { throw new Error('Failed to save background state'); }
    if (!committed) { return; }
    volatileImagePath = undefined;
    onDidChangeGlobalState.fire();
}

export async function setCurrentImagePath(imagePath: string, options: SetImageOptions = {}): Promise<void> {
    if (options.shouldPersist && !options.shouldPersist()) { return; }
    const value = imagePath || '';
    if (options.persist === false) {
        volatileImagePath = value;
        onDidChangeGlobalState.fire();
        return;
    }

    // 有显式持久化写入时，内存态的临时图就失去意义了。
    await persistWorkspaceImage(value, options);
}

/**
 * 解析当前生效的透明度/模糊度。
 *
 * **只读共享设置文件**（`~/.wallpaper-studio/settings.json`）。
 *
 * 之前这里还会先查 globalState 里的「窗口级 / 工作区级」记录 —— 而 globalState
 * 是**按 profile 隔离**的。切到另一个 profile 时，那份记录里躺着的旧值（历史迁移
 * 写入的 0.5 / 0.8）会直接盖掉共享设置里的 0，表现就是"一切换 profile 透明度
 * 突然拉满、界面全看不清"。既然要求所有 profile 共用一份设置，这两层必须去掉。
 */
function clampOpacity(value: number): number {
    if (!Number.isFinite(value)) { return 0; }
    // 上限沿用旧设置项的范围：超过 0.8 背景会盖住编辑器内容。
    return Math.min(0.8, Math.max(0, value));
}

function clampBlur(value: number): number {
    if (!Number.isFinite(value)) { return 0; }
    return Math.min(100, Math.max(0, value));
}

export function resolveCurrentOpacity(settingsFallback: number): number {
    return clampOpacity(settingsFallback);
}

export function resolveCurrentBlur(settingsFallback: number): number {
    return clampBlur(settingsFallback);
}

/**
 * 写入透明度/模糊度。
 *
 * 只写共享设置文件；不再往 globalState 的窗口/工作区映射里写 ——
 * 那份数据按 profile 隔离，正是"切 profile 后数值错乱"的来源。
 * 历史映射在启动迁移时清理，runtime.json 不再保存这些无效字段。
 */
export async function setCurrentOpacity(value: number, cfg: WorkspaceConfiguration): Promise<void> {
    if (!Number.isFinite(value)) { return; }
    await cfg.update('opacity', clampOpacity(value), ConfigurationTarget.Global);
}

/** 写入模糊度，语义同 setCurrentOpacity。 */
export async function setCurrentBlur(value: number, cfg: WorkspaceConfiguration): Promise<void> {
    if (!Number.isFinite(value)) { return; }
    await cfg.update('blur', clampBlur(value), ConfigurationTarget.Global);
}

function pruneRecords<T extends string | number>(map: Record<string, T>, keepKey: string): Record<string, T> {
    const keys = Object.keys(map);
    if (keys.length <= MAX_WORKSPACE_RECORDS) {
        return map;
    }
    const pruned = { ...map };
    let toRemove = keys.length - MAX_WORKSPACE_RECORDS;
    for (const key of keys) {
        if (toRemove <= 0) {
            break;
        }
        if (key === keepKey) {
            continue;
        }
        delete pruned[key];
        toRemove--;
    }
    return pruned;
}

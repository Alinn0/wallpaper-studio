import * as crypto from 'crypto';
import * as path from 'path';
import { ConfigurationTarget, env, workspace, WorkspaceConfiguration } from 'vscode';
import { getContext, onDidChangeGlobalState } from './global';
import { getAppConfig } from './settingsStore';
import { readRuntimeState, updateRuntimeState } from './runtimeStore';

const WORKSPACE_IMAGES_KEY = 'wallpaperStudio.workspaceImages';
// 全局兜底图。以前这个角色由 settings.json 的 wallpaperStudio.imagePath 承担，
// 但那份值只在首次为空时写入、之后永久冻结，settings.json 会长期停留在用户第一次
// 选的那张图上。改用独立的 globalState key 后，settings.json 只作为老用户的迁移
// 兜底读取，扩展不再回写它。
const NO_WORKSPACE_KEY = 'no-workspace';

// 透明度/模糊度与背景图走同一套「窗口(session) → 工作区 → 兜底」的解析链，
// 让不同工作区的窗口在 webview 里各自显示自己的数值。区别只在最后一层：
// 背景图有 globalState 里的"最后一张全局兜底"，透明度/模糊度则直接落到
// settings.json 的配置值——用户在某窗口调透明度不应该把其他窗口的显示值也
// 刷成同一个数（而且那些窗口的实际渲染用的仍是它们各自记录的旧值，数值跟着
// 全局配置走反而会造成"显示值与实际效果不一致"的困惑）。
const WINDOW_OPACITY_KEY = 'wallpaperStudio.windowOpacity';
const WORKSPACE_OPACITY_KEY = 'wallpaperStudio.workspaceOpacity';
const WINDOW_BLUR_KEY = 'wallpaperStudio.windowBlur';
const WORKSPACE_BLUR_KEY = 'wallpaperStudio.workspaceBlur';

// window 记录以 session 为键，而 session 每次启动/重载都会变，这张表只增不减。
// 保留最近若干条(按插入顺序淘汰)，当前窗口的记录永不淘汰。
const MAX_WINDOW_RECORDS = 40;

// 非持久化更新(定时自动换图)只改内存：既避免每个间隔都写两个 globalState key
// 并连带刷新 TreeView/Studio，也避免把"换图失败的地址"落盘。session 结束即失效，
// 这本身就是 persist=false 期望的语义。
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

    const normalized = path.normalize(folder.uri.fsPath).replace(/\\+/g, '/').replace(/\/+$/, '').toLowerCase();
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

export interface SetImageOptions {
    /** false 表示只更新当前窗口的内存态，不写入 runtime.json。 */
    persist?: boolean;
}

/**
 * 把值按当前打开的文件夹写入 runtime.json。无工作区时使用固定的
 * no-workspace 键；同一文件夹的多个 VS Code 窗口因此共享同一张壁纸。
 */
async function persistLevelValue(
    workspaceKey: string,
    value: string | number
): Promise<void> {
    const workspaceHash = getWorkspaceKey();
    const saved = await updateRuntimeState(runtime => {
        const workspaceMap: Record<string, string | number> = workspaceKey === WORKSPACE_IMAGES_KEY
            ? runtime.workspaceImages
            : workspaceKey === WORKSPACE_OPACITY_KEY ? runtime.workspaceOpacity : runtime.workspaceBlur;
        if (workspaceHash) {
            delete workspaceMap[workspaceHash];
            workspaceMap[workspaceHash] = value;
            const prunedWorkspaceMap = pruneRecords(workspaceMap, workspaceHash);
            Object.keys(workspaceMap).forEach(key => {
                if (!(key in prunedWorkspaceMap)) { delete workspaceMap[key]; }
            });
        }
    });
    if (!saved) { return; }
    onDidChangeGlobalState.fire();
}

export async function setCurrentImagePath(imagePath: string, options: SetImageOptions = {}): Promise<void> {
    const value = imagePath || '';
    if (options.persist === false) {
        volatileImagePath = value;
        onDidChangeGlobalState.fire();
        return;
    }

    // 有显式持久化写入时，内存态的临时图就失去意义了。
    volatileImagePath = undefined;

    await persistLevelValue(WORKSPACE_IMAGES_KEY, value);
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
 * 顺手把历史遗留的映射清空一次，避免老版本数据继续影响别的窗口。
 */
export async function setCurrentOpacity(value: number, cfg: WorkspaceConfiguration): Promise<void> {
    if (!Number.isFinite(value)) { return; }
    await cfg.update('opacity', clampOpacity(value), ConfigurationTarget.Global);
    await purgeLegacyLevelRecords();
}

/** 写入模糊度，语义同 setCurrentOpacity。 */
export async function setCurrentBlur(value: number, cfg: WorkspaceConfiguration): Promise<void> {
    if (!Number.isFinite(value)) { return; }
    await cfg.update('blur', clampBlur(value), ConfigurationTarget.Global);
    await purgeLegacyLevelRecords();
}

/** 清掉按 profile 存储的旧透明度/模糊度记录（一次性，失败不影响主流程）。 */
let legacyLevelPurged = false;
async function purgeLegacyLevelRecords(): Promise<void> {
    if (legacyLevelPurged) { return; }
    legacyLevelPurged = true;
    try {
        const state = getContext().globalState;
        for (const key of [WINDOW_OPACITY_KEY, WORKSPACE_OPACITY_KEY, WINDOW_BLUR_KEY, WORKSPACE_BLUR_KEY]) {
            if (state.get<unknown>(key) !== undefined) {
                await state.update(key, undefined);
            }
        }
    } catch {
        // 清理失败只影响"旧值残留"，下一次启动会再试。
        legacyLevelPurged = false;
    }
}

function pruneRecords<T extends string | number>(map: Record<string, T>, keepKey: string): Record<string, T> {
    const keys = Object.keys(map);
    if (keys.length <= MAX_WINDOW_RECORDS) {
        return map;
    }
    const pruned = { ...map };
    let toRemove = keys.length - MAX_WINDOW_RECORDS;
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

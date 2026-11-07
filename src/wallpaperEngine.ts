import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VIDEO_EXTS } from './mediaTypes';
import { normalizeComparablePath } from './pathComparison';

export const DEFAULT_WALLPAPER_CONFIG =
    'E:\\Games\\Steam\\steamapps\\common\\wallpaper_engine\\config.json';
const REMOVED_KEY = 'wallpaperStudioWallpaperRemoved';
const PROPERTIES_KEY = 'wallpaperStudioWallpaperProperties';
/** 上次判定出的「当前壁纸引擎用户」，用于跨启动核验用户名是否变过。 */
export const WALLPAPER_USER_KEY = 'wallpaperStudioWallpaperUser';
/** 未登录 / 默认用户节点，例如 defaultuser100000。 */
const DEFAULT_USER_PATTERN = /^defaultuser\d*$/i;

export interface WallpaperEntry {
    path: string;
    title: string;
    description: string;
    preview: string;
    sceneSource: string;
    active: boolean;
    properties: WallpaperProperty[];
}

export interface WallpaperProperty {
    key: string;
    type: string;
    text: string;
    value: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ label: string; value: string }>;
}

function normalize(value: string): string {
    return normalizeComparablePath(value);
}

function readJson(filePath: string): any {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

/**
 * config.json 顶层的用户节点名（壁纸引擎账号名）。
 * `?installdirectory` 这类以 `?` 开头的键是元数据，不是用户。
 */
function listWallpaperUsers(root: any): string[] {
    return Object.keys(root || {}).filter(key => !key.startsWith('?'));
}

/** 读取单个用户的播放列表（合并该用户下所有显示器的条目）。 */
function readUserPlaylist(root: any, user: string): string[] {
    const selected = root?.[user]?.general?.wallpaperconfig?.selectedwallpapers;
    if (!selected || typeof selected !== 'object') { return []; }
    const result: string[] = [];
    for (const monitor of Object.values(selected)) {
        const items = (monitor as any)?.playlist?.items;
        if (!Array.isArray(items)) { continue; }
        for (const item of items) {
            if (typeof item === 'string' && item.trim()) { result.push(item.trim()); }
        }
    }
    return result;
}

/**
 * 从 Steam 的 loginusers.vdf 里取用户昵称，用作匹配壁纸引擎账号名的补充线索。
 * 壁纸引擎账号名通常是 Steam 昵称，但也可能被改成任意名字，所以只当候选之一。
 */
function readSteamPersonaNames(configPath: string): string[] {
    try {
        // <steam>/steamapps/common/wallpaper_engine/config.json → <steam>
        const steamRoot = path.resolve(path.dirname(configPath), '..', '..', '..');
        const vdfPath = path.join(steamRoot, 'config', 'loginusers.vdf');
        if (!fs.existsSync(vdfPath)) { return []; }
        const text = fs.readFileSync(vdfPath, 'utf8');
        const names: string[] = [];
        const pattern = /"(?:PersonaName|AccountName)"\s+"([^"]+)"/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            if (match[1] && match[1].trim()) { names.push(match[1].trim()); }
        }
        return names;
    } catch {
        return [];
    }
}

export interface ActiveWallpaperUser {
    user: string;
    /** 判定依据，仅用于日志排查。 */
    source: 'stored' | 'os' | 'steam' | 'playlist' | 'first';
}

export function getWallpaperUsers(configPath: string): string[] {
    try {
        return listWallpaperUsers(readJson(configPath));
    } catch {
        return [];
    }
}

/**
 * 判定「当前正在运行的用户」。
 *
 * config.json 里没有显式标记谁在使用，只能按可信度依次探测：
 * 1. 上次记住的用户（跨启动保持一致，避免用户名不变时来回跳）；
 * 2. 当前 Windows 登录名（壁纸引擎默认用它当账号名）；
 * 3. Steam 登录昵称 / 账号名；
 * 4. 唯一一个播放列表非空且不是 defaultuser 的节点；
 * 5. 第一个真实用户节点。
 */
export function resolveActiveWallpaperUser(
    configPath: string,
    stored?: string
): ActiveWallpaperUser | undefined {
    let root: any;
    try {
        root = readJson(configPath);
    } catch {
        return undefined;
    }
    const users = listWallpaperUsers(root);
    if (!users.length) { return undefined; }
    const find = (name: string): string => {
        const target = (name || '').trim().toLowerCase();
        if (!target) { return ''; }
        return users.find(user => user.toLowerCase() === target) || '';
    };

    if (stored) {
        const hit = find(stored);
        // 记住的如果是 defaultuser 说明上次判错了，不要继续沿用。
        if (hit && !DEFAULT_USER_PATTERN.test(hit)) { return { user: hit, source: 'stored' }; }
    }

    const osUser = find(os.userInfo().username);
    if (osUser) { return { user: osUser, source: 'os' }; }

    for (const name of readSteamPersonaNames(configPath)) {
        const hit = find(name);
        if (hit) { return { user: hit, source: 'steam' }; }
    }

    const realUsers = users.filter(user => !DEFAULT_USER_PATTERN.test(user));
    const nonEmpty = realUsers.filter(user => readUserPlaylist(root, user).length > 0);
    if (nonEmpty.length) { return { user: nonEmpty[0], source: 'playlist' }; }
    if (realUsers.length) { return { user: realUsers[0], source: 'first' }; }
    return undefined;
}

export function resolveWallpaperMediaPath(value: string): string {
    const resolved = path.normalize(value);
    try {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            const scene = path.join(resolved, 'scene.pkg');
            if (fs.existsSync(scene) && fs.statSync(scene).isFile()) { return scene; }
        }
        const base = path.basename(resolved).toLowerCase();
        if ((base === 'project.json' || base === 'scene.json') && fs.existsSync(path.join(path.dirname(resolved), 'scene.pkg'))) {
            return path.join(path.dirname(resolved), 'scene.pkg');
        }
    } catch {
        // Keep the original path so the normal renderer can report its error.
    }
    return resolved;
}

function resolvePackagePath(value: string, configPath: string, root: any): string {
    const candidates = [value];
    if (!path.isAbsolute(value)) {
        candidates.push(path.resolve(path.dirname(configPath), value));
        const installDirectory = typeof root?.['?installdirectory'] === 'string'
            ? root['?installdirectory']
            : '';
        if (installDirectory) { candidates.push(path.resolve(installDirectory, value)); }
    }
    for (const candidate of candidates) {
        try {
            const resolved = resolveWallpaperMediaPath(candidate);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                return resolveWallpaperMediaPath(resolved);
            }
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                const scene = path.join(resolved, 'scene.pkg');
                if (fs.existsSync(scene) && fs.statSync(scene).isFile()) { return scene; }
            }
            if (path.basename(resolved).toLowerCase() === 'project.json') {
                const scene = path.join(path.dirname(resolved), 'scene.pkg');
                if (fs.existsSync(scene) && fs.statSync(scene).isFile()) { return scene; }
            }
        } catch {
            // Ignore malformed or inaccessible playlist entries and continue.
        }
    }
    return path.normalize(value);
}

interface ProjectInfo {
    title: string;
    description: string;
    preview: string;
    properties: WallpaperProperty[];
    /** project.json 的 `type`：scene / video / web / application … */
    projectType: string;
    /** project.json 的 `file`：真正的媒体/入口文件名。 */
    entryFile: string;
}

/** 支持在扩展里渲染的壁纸种类。其余（web / application / 未知）在导入时会被排除。 */
export type WallpaperKind = 'scene' | 'video' | 'web' | 'application' | 'other';

const VIDEO_EXTENSIONS = VIDEO_EXTS;

/**
 * 判定一张壁纸属于哪种类型。
 *
 * 优先级：实际文件扩展名 → project.json 的 `type`。
 * 场景包一律按 scene 处理（包括 `scene.json` 已被解析成 `scene.pkg` 的情况）；
 * `.html` / `type: web` / `type: application` 属于本扩展渲染不了的类型。
 */
export function classifyWallpaperPath(filePath: string): WallpaperKind {
    const lower = filePath.toLowerCase().split('?')[0];
    const ext = path.extname(lower);
    if (ext === '.pkg') { return 'scene'; }
    if (ext === '.html' || ext === '.htm') { return 'web'; }
    if (VIDEO_EXTENSIONS.includes(ext)) { return 'video'; }
    const project = getProjectInfo(filePath);
    const type = project.projectType.toLowerCase();
    if (type === 'web') { return 'web'; }
    if (type === 'application') { return 'application'; }
    if (type === 'video') { return 'video'; }
    if (type === 'scene') {
        // type=scene 但入口不是 pkg：只有同目录真的存在 scene.pkg 才算场景包。
        return resolveWallpaperMediaPath(filePath).toLowerCase().endsWith('.pkg') ? 'scene' : 'other';
    }
    return 'other';
}

/** 本扩展能渲染的壁纸（场景包 / 视频）。 */
export function isSupportedWallpaperKind(kind: WallpaperKind): boolean {
    return kind === 'scene' || kind === 'video';
}

/** project.json 解析缓存：pushState 频繁触发，避免每次都同步读盘 + JSON.parse。 */
const projectInfoCache = new Map<string, { mtimeMs: number; info: ProjectInfo }>();
const PROJECT_CACHE_LIMIT = 400;

/** 项目属性的 `text` 里允许出现 `<small>` 之类的内联标记，统一去掉再展示。 */
function stripMarkup(value: string): string {
    return value
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Wallpaper Engine 的属性类型和 Web 控件的对应关系：
 *   text          章节分隔标题（不可编辑）
 *   group         分组标题（不可编辑）
 *   label         纯说明文字（不可编辑）
 *   usershortcut  用户快捷方式（文件路径输入）
 *   scenetexture  用户贴图（文件路径输入）
 * `Text` 等大小写变体统一按小写处理。
 */
function normalizePropertyType(rawType: unknown): string {
    const type = typeof rawType === 'string' ? rawType.toLowerCase() : 'textinput';
    switch (type) {
        case 'bool':
        case 'color':
        case 'combo':
        case 'slider':
        case 'textinput':
            return type;
        case 'text':
            return 'header';
        case 'group':
            return 'group';
        case 'label':
            return 'label';
        case 'usershortcut':
        case 'scenetexture':
            return 'file';
        default:
            return 'textinput';
    }
}

/** `ui_browse_properties_scheme_color` 是工坊页面用的提示字段，不是可配置项。 */
function isHiddenProperty(key: string, text: string): boolean {
    return /schemecolor$/i.test(key) || /^ui_/i.test(text);
}

function readProjectProperties(project: any): WallpaperProperty[] {
    const raw = project?.general?.properties;
    if (!raw || typeof raw !== 'object') { return []; }
    const entries = Object.entries(raw as Record<string, any>)
        .filter(([, value]) => value && typeof value === 'object')
        .map(([key, value], index) => ({
            key,
            value,
            // WE 用 order 排序；缺失时退化成 index，再退化成声明顺序。
            rank: Number.isFinite(Number(value.order))
                ? Number(value.order)
                : Number.isFinite(Number(value.index)) ? Number(value.index) : 1000 + index
        }))
        .sort((a, b) => a.rank - b.rank);

    const properties: WallpaperProperty[] = [];
    for (const { key, value } of entries) {
        const text = stripMarkup(typeof value.text === 'string' ? value.text : key);
        if (isHiddenProperty(key, text)) { continue; }
        let type = normalizePropertyType(value.type);
        const options = Array.isArray(value.options)
            ? value.options
                .filter((option: any) => option && typeof option === 'object')
                .map((option: any) => ({
                    label: stripMarkup(String(option.label ?? option.value ?? '')),
                    value: String(option.value ?? option.label ?? '')
                }))
            : undefined;
        if (type === 'combo' && !options?.length) { type = 'textinput'; }
        properties.push({
            key,
            type,
            text: text || key,
            value: value.value,
            min: typeof value.min === 'number' ? value.min : undefined,
            max: typeof value.max === 'number' ? value.max : undefined,
            step: typeof value.step === 'number' ? value.step : undefined,
            options
        });
    }
    return properties;
}

/** 交给渲染引擎的 project.json 声明（WebWallGL 靠它把属性值绑定回 scene.json）。 */
export interface WallpaperProjectDeclaration {
    type: 'scene';
    file: string;
    title?: string;
    general: { properties: Record<string, Record<string, unknown>> };
}

/** 声明里保留的字段，与 WebWallGL 的 DECL_FIELDS 对齐。 */
const DECLARATION_FIELDS = [
    'text', 'min', 'max', 'step', 'precision', 'fraction', 'options', 'order', 'index', 'condition'
] as const;

const declarationCache = new Map<string, { mtimeMs: number; declaration?: WallpaperProjectDeclaration }>();

/**
 * 清空项目元数据缓存，让下一次读取真正回盘。
 *
 * 「重新读取配置」按钮要看到用户刚改过的 project.json（标题、类型、属性、
 * 入口文件），而这两个缓存按 mtime 命中 —— 同一秒内改文件时 mtime 可能不变，
 * 于是仍然返回旧结果。这里直接清空，保证读到的是磁盘上的当前内容。
 */
export function clearWallpaperProjectCache(): void {
    projectInfoCache.clear();
    declarationCache.clear();
}

/**
 * 把 project.json 的 `general.properties` 原样整理成引擎可用的声明。
 *
 * 这一步是实时更新的关键：WebWallGL 的 `parseScene()` 用 `project.general.properties`
 * 建立属性表，`setProperties()` 推来的值只有在属性表里存在声明时才会写回
 * scene.json 的 `{user: ...}` 绑定。只给 `{type:'scene', file:'scene.json'}`
 * 时属性表为空，值只会进脚本环境，画面完全不变。
 */
export function getWallpaperProjectDeclaration(filePath: string): WallpaperProjectDeclaration | undefined {
    if (!filePath || /^(https?|data):/i.test(filePath)) { return undefined; }
    const packagePath = resolveWallpaperMediaPath(filePath);
    const projectPath = path.join(path.dirname(packagePath), 'project.json');
    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(projectPath).mtimeMs;
        const cached = declarationCache.get(projectPath);
        if (cached && cached.mtimeMs === mtimeMs) { return cached.declaration; }
    } catch {
        return undefined;
    }

    let declaration: WallpaperProjectDeclaration | undefined;
    try {
        const project = readJson(projectPath);
        const raw = project?.general?.properties;
        if (raw && typeof raw === 'object') {
            const properties: Record<string, Record<string, unknown>> = {};
            for (const [name, value] of Object.entries(raw as Record<string, any>)) {
                if (!value || typeof value !== 'object') { continue; }
                const entry: Record<string, unknown> = {};
                const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
                if (!type) { continue; }
                entry.type = type;
                if (value.value !== undefined) { entry.value = value.value; }
                for (const field of DECLARATION_FIELDS) {
                    const fieldValue = value[field];
                    if (fieldValue === undefined) { continue; }
                    if (field === 'options') {
                        if (!Array.isArray(fieldValue)) { continue; }
                        const options = fieldValue
                            .filter((option: any) => option && typeof option === 'object')
                            .map((option: any) => ({
                                label: String(option.label ?? option.value ?? ''),
                                value: String(option.value ?? option.label ?? '')
                            }));
                        if (options.length) { entry.options = options; }
                    } else if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
                        entry[field] = fieldValue;
                    } else if (typeof fieldValue === 'string' && fieldValue.trim()) {
                        entry[field] = fieldValue.trim().slice(0, 500);
                    }
                }
                properties[name] = entry;
            }
            if (Object.keys(properties).length) {
                // `file` 必须是松散工程入口（.json）；指向 .pkg 时按 scene.json 处理，
                // 与参考实现的归一化一致，否则引擎会走错误的资源装配分支。
                const rawFile = typeof project.file === 'string' ? project.file.trim() : '';
                const file = /\.json$/i.test(rawFile) ? rawFile.replace(/^\.?\//, '') : 'scene.json';
                const title = typeof project.title === 'string' && project.title.trim()
                    ? stripMarkup(project.title)
                    : undefined;
                declaration = {
                    type: 'scene',
                    file,
                    ...(title ? { title } : {}),
                    general: { properties }
                };
            }
        }
    } catch {
        declaration = undefined;
    }

    if (declarationCache.size >= PROJECT_CACHE_LIMIT) {
        const oldest = declarationCache.keys().next().value;
        if (oldest) { declarationCache.delete(oldest); }
    }
    declarationCache.set(projectPath, { mtimeMs, declaration });
    return declaration;
}

function getProjectInfo(packagePath: string): ProjectInfo {
    const directory = path.dirname(packagePath);
    const projectPath = path.join(directory, 'project.json');
    try {
        const stat = fs.statSync(projectPath);
        const cached = projectInfoCache.get(projectPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) { return cached.info; }
        const project = readJson(projectPath);
        const previewName = typeof project.preview === 'string' ? project.preview : 'preview.jpg';
        const info: ProjectInfo = {
            title: typeof project.title === 'string' && project.title.trim()
                ? stripMarkup(project.title)
                : path.basename(directory),
            description: typeof project.description === 'string' ? project.description : '',
            preview: path.join(directory, previewName),
            properties: readProjectProperties(project),
            projectType: typeof project.type === 'string' ? project.type.trim() : '',
            entryFile: typeof project.file === 'string' ? project.file.trim() : ''
        };
        if (projectInfoCache.size >= PROJECT_CACHE_LIMIT) {
            const oldest = projectInfoCache.keys().next().value;
            if (oldest) { projectInfoCache.delete(oldest); }
        }
        projectInfoCache.set(projectPath, { mtimeMs: stat.mtimeMs, info });
        return info;
    } catch {
        return { title: path.basename(directory), description: '', preview: path.join(directory, 'preview.jpg'), properties: [], projectType: '', entryFile: '' };
    }
}

export function getWallpaperProjectProperties(filePath: string): WallpaperProperty[] {
    if (!filePath || /^(https?|data):/i.test(filePath)) { return []; }
    return getProjectInfo(resolveWallpaperMediaPath(filePath)).properties;
}

export function getWallpaperConfigPath(value?: string): string {
    return value || DEFAULT_WALLPAPER_CONFIG;
}

export function hasWallpaperConfig(configPath?: string): boolean {
    return !!configPath && fs.existsSync(configPath);
}

/**
 * 读取播放列表。
 *
 * @param user 指定后只读该用户节点的播放列表（当前正在运行的用户）。
 *             不传则退回「所有用户合并」的旧行为。
 */
export function readWallpaperPlaylist(
    configPath: string,
    removed: string[] = [],
    user?: string,
    onProgress?: (loaded: number, total: number) => void
): WallpaperEntry[] {
    const root = readJson(configPath);
    const users = listWallpaperUsers(root);
    const owner = user ? users.find(item => item === user) : undefined;
    // 指定了用户但 config.json 里已经没有这个节点：说明账号被换掉/删除了，
    // 不能偷偷退回全量列表，否则又会随机到别人的壁纸。
    if (user && !owner) { return []; }
    const targets = owner ? [owner] : users;
    const removedKeys = new Set(removed.map(normalize));
    const paths = targets
        .flatMap(item => readUserPlaylist(root, item))
        .map(item => resolvePackagePath(item, configPath, root));
    onProgress?.(0, paths.length);
    const entries: WallpaperEntry[] = [];
    for (const [index, wallpaperPath] of paths.entries()) {
        onProgress?.(index + 1, paths.length);
        const kind = classifyWallpaperPath(wallpaperPath);
        // 只保留扩展能渲染的类型：场景包与视频。
        // 网页壁纸（type=web / .html）和应用程序壁纸（type=application）一律不导入，
        // 否则列表里会出现点了没反应、或者只能显示项目预览图的条目。
        if (!isSupportedWallpaperKind(kind)) { continue; }
        const info = getProjectInfo(wallpaperPath);
        // 视频条目如果配置里给的是 project.json / 目录，用 project.file 指回真实媒体文件。
        let mediaPath = wallpaperPath;
        if (kind === 'video' && !VIDEO_EXTENSIONS.includes(path.extname(mediaPath).toLowerCase())) {
            const candidate = info.entryFile
                ? path.join(path.dirname(mediaPath), info.entryFile)
                : '';
            if (candidate && fs.existsSync(candidate)) { mediaPath = candidate; }
        }
        entries.push({
            path: mediaPath,
            title: info.title,
            description: info.description,
            preview: fs.existsSync(info.preview) ? info.preview : '',
            sceneSource: kind === 'scene' ? mediaPath : '',
            active: !removedKeys.has(normalize(mediaPath)),
            properties: info.properties
        });
    }
    if (!paths.length) { onProgress?.(0, 0); }
    const seen = new Set<string>();
    return entries.filter(entry => {
        const key = normalize(entry.path);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

/** 让出事件循环：解析期间必须能发出进度消息、让面板重绘。 */
function yieldToEventLoop(): Promise<void> {
    return new Promise<void>(resolve => {
        const immediate = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
        if (typeof immediate === 'function') {
            immediate(resolve);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

/**
 * 分批读取播放列表，避免大量 project.json 同步解析长时间占用扩展宿主事件循环。
 * 进度回调只报告当前项，不负责发送完整面板状态。
 *
 * 每处理一项都让出一次事件循环：只有真正回到事件循环，进度消息才会被发出去，
 * 面板才能实时看到「正在加载壁纸：已加载/总数量」在走，而不是结束时一次性出现。
 */
export async function readWallpaperPlaylistAsync(
    configPath: string,
    removed: string[] = [],
    user?: string,
    onProgress?: (loaded: number, total: number) => void
): Promise<WallpaperEntry[]> {
    const root = readJson(configPath);
    const users = listWallpaperUsers(root);
    const owner = user ? users.find(item => item === user) : undefined;
    if (user && !owner) { return []; }
    const targets = owner ? [owner] : users;
    const removedKeys = new Set(removed.map(normalize));
    const paths = targets
        .flatMap(item => readUserPlaylist(root, item))
        .map(item => resolvePackagePath(item, configPath, root));
    const entries: WallpaperEntry[] = [];
    onProgress?.(0, paths.length);

    for (const [index, wallpaperPath] of paths.entries()) {
        const kind = classifyWallpaperPath(wallpaperPath);
        if (isSupportedWallpaperKind(kind)) {
            const info = getProjectInfo(wallpaperPath);
            let mediaPath = wallpaperPath;
            if (kind === 'video' && !VIDEO_EXTENSIONS.includes(path.extname(mediaPath).toLowerCase())) {
                const candidate = info.entryFile
                    ? path.join(path.dirname(mediaPath), info.entryFile)
                    : '';
                if (candidate && fs.existsSync(candidate)) { mediaPath = candidate; }
            }
            entries.push({
                path: mediaPath,
                title: info.title,
                description: info.description,
                preview: fs.existsSync(info.preview) ? info.preview : '',
                sceneSource: kind === 'scene' ? mediaPath : '',
                active: !removedKeys.has(normalize(mediaPath)),
                properties: info.properties
            });
        }
        onProgress?.(index + 1, paths.length);
        await yieldToEventLoop();
    }

    const seen = new Set<string>();
    return entries.filter(entry => {
        const key = normalize(entry.path);
        if (seen.has(key)) { return false; }
        seen.add(key);
        return true;
    });
}

export function readRemovedWallpapers(globalState: { get<T>(key: string, defaultValue: T): T }): string[] {
    return globalState.get<string[]>(REMOVED_KEY, []);
}

interface WallpaperPlaylistCache {
    configPath: string;
    user: string;
    removedKey: string;
    entries: WallpaperEntry[];
}

let playlistCache: WallpaperPlaylistCache | undefined;

function removedKeyOf(removed: string[]): string {
    return removed.map(normalize).sort().join('\n');
}

/**
 * 记住最近一次完整解析的结果。
 *
 * 随机/上一张/自动轮播只需要候选路径，没必要为了取路径同步解析上百个
 * project.json；条件（config 路径 / 用户 / 移除列表）一致时直接复用。
 */
export function rememberWallpaperPlaylist(
    configPath: string,
    removed: string[],
    user: string | undefined,
    entries: WallpaperEntry[]
): void {
    playlistCache = {
        configPath: normalize(configPath),
        user: user || '',
        removedKey: removedKeyOf(removed),
        entries
    };
}

export function forgetWallpaperPlaylist(): void {
    playlistCache = undefined;
}

export function readCachedWallpaperPlaylist(
    configPath: string,
    removed: string[] = [],
    user?: string
): WallpaperEntry[] | undefined {
    if (!playlistCache) { return undefined; }
    if (playlistCache.configPath !== normalize(configPath)) { return undefined; }
    if (playlistCache.user !== (user || '')) { return undefined; }
    if (playlistCache.removedKey !== removedKeyOf(removed)) { return undefined; }
    return playlistCache.entries;
}

export function removeWallpaper(
    globalState: { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> },
    wallpaperPath: string
): Thenable<void> {
    const current = readRemovedWallpapers(globalState);
    const key = normalize(wallpaperPath);
    const next = [...current.filter(item => normalize(item) !== key), wallpaperPath];
    return globalState.update(REMOVED_KEY, next);
}

export function getWallpaperPropertyOverrides(
    globalState: { get<T>(key: string, defaultValue: T): T },
    wallpaperPath: string
): Record<string, unknown> {
    const all = globalState.get<Record<string, Record<string, unknown>>>(PROPERTIES_KEY, {});
    return all[normalize(wallpaperPath)] || {};
}

export async function setWallpaperProperty(
    globalState: { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> },
    wallpaperPath: string,
    key: string,
    value: unknown
): Promise<void> {
    const all = globalState.get<Record<string, Record<string, unknown>>>(PROPERTIES_KEY, {});
    const current = all[normalize(wallpaperPath)] || {};
    await globalState.update(PROPERTIES_KEY, {
        ...all,
        [normalize(wallpaperPath)]: { ...current, [key]: value }
    });
}

export async function setWallpaperProperties(
    globalState: { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> },
    wallpaperPath: string,
    properties: Record<string, unknown>
): Promise<void> {
    const all = globalState.get<Record<string, Record<string, unknown>>>(PROPERTIES_KEY, {});
    const current = all[normalize(wallpaperPath)] || {};
    await globalState.update(PROPERTIES_KEY, {
        ...all,
        [normalize(wallpaperPath)]: { ...current, ...properties }
    });
}

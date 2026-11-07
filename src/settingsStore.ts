import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Disposable, EventEmitter, Event } from 'vscode';
import * as lockfile from 'proper-lockfile';
import { atomicWriteTextSync } from './atomicWrite';

/**
 * 扩展自己的全局设置存储。
 *
 * 为什么不用 `contributes.configuration`：
 *  - 那样每条设置都会出现在 VS Code 的设置页面里，而这个插件的所有调节都应该在
 *    自己的 UI 里完成；
 *  - 更重要的是 **profiles**：VS Code 的 `settings.json` / `globalState` 都是按
 *    profile 隔离的，切一个 profile 就变成另一套配置。用户要求"所有 profiles
 *    共享同一份设置"，只能写到主目录下的独立文件。
 *
 * 文件位置：`~/.wallpaper-studio/settings.json`（跨 profile、跨 workspace 共享）。
 */

export const SETTINGS_DIR = process.env.WALLPAPER_STUDIO_DATA_DIR || path.join(os.homedir(), '.wallpaper-studio');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

export interface AppSettings {
    /** 设置文件结构版本（用于一次性修复历史迁移错误）。 */
    version?: number;
    opacity: number;
    blur: number;
    imagePath: string;
    perWindowBackground: boolean;
    randomImageFolder: string;
    autoStatus: boolean;
    autoInterval: number;
    sizeModel: string;
    blendModel: string;
    forceHttpsUpgrade: boolean;
    /** 内部标记：是否已经尝试过从旧版 settings.json 迁移。 */
    seeded?: boolean;
}

/** 共享偏好的唯一默认值来源；性能调度与派生缓存不写入用户偏好。 */
export const DEFAULT_SETTINGS: AppSettings = {
    // 透明度/模糊度默认 0：壁纸默认原样显示，需要柔化时再由用户在 UI 里调。
    opacity: 0,
    blur: 0,
    imagePath: '',
    perWindowBackground: true,
    randomImageFolder: '',
    autoStatus: false,
    autoInterval: 0,
    sizeModel: 'cover',
    blendModel: 'auto',
    forceHttpsUpgrade: true,
    seeded: false
};

const NUMERIC_KEYS = new Set(['opacity', 'blur', 'autoInterval']);
const BOOLEAN_KEYS = new Set(['perWindowBackground', 'autoStatus', 'forceHttpsUpgrade']);

/**
 * 设置文件版本。
 *
 * v1 的迁移逻辑有两个 bug：
 *  1. 直接截取 settings.json 里的**原始文本**当值，没有按 JSON 反转义，
 *     于是 `e:\\壁纸` 变成字面量 `e:\\壁纸`（反斜杠翻倍），目录直接失效；
 *  2. 遍历所有 profile 时**后写覆盖前写**，最终值可能来自另一个 profile
 *     （实测把用户的 `blendModel: "lighten"` 覆盖成了 `"multiply"`，
 *     而 multiply 叠在深色工作台上等于全黑 —— 表现就是"背景不显示"）。
 *
 * v3：透明度 / 模糊度改为 UI 独占（默认 0，不再从 VS Code settings.json 迁移），
 * 并修复 v1/v2 遗留的这两个值。
 */
const SETTINGS_VERSION = 3;

/** 从旧 VS Code settings.json 迁移的键。透明度/模糊度由插件 UI 独占，不参与迁移。 */
const SEEDABLE_KEYS = Object.keys(DEFAULT_SETTINGS).filter(
    key => key !== 'seeded' && key !== 'version' && key !== 'opacity' && key !== 'blur'
);

let cache: AppSettings | null = null;
const changeEmitter = new EventEmitter<string[]>();
const externalChangeEmitter = new EventEmitter<string[]>();
export const onDidChangeExternalSettings: Event<string[]> = externalChangeEmitter.event;

/** 设置变化（参数是变化的键名）。 */
export const onDidChangeSettings: Event<string[]> = changeEmitter.event;

function coerce<K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K] | undefined {
    if (NUMERIC_KEYS.has(key as string)) {
        const num = typeof value === 'number' ? value : Number(value);
        return (Number.isFinite(num) ? num : undefined) as AppSettings[K] | undefined;
    }
    if (BOOLEAN_KEYS.has(key as string)) {
        if (typeof value === 'boolean') { return value as AppSettings[K]; }
        if (value === 'true') { return true as AppSettings[K]; }
        if (value === 'false') { return false as AppSettings[K]; }
        return undefined;
    }
    if (typeof value === 'string') { return value as AppSettings[K]; }
    return undefined;
}

/**
 * 从旧版 settings.json（含各 profile）里捞一次已有配置，避免升级后设置丢失。
 *
 * 两个必须遵守的细节：
 *  - 用 `JSON.parse` 反转义捕获到的字面量。settings.json 里的 Windows 路径写作
 *    `"e:\\壁纸"`，直接当字符串用会得到 `e:\\壁纸`（两个反斜杠），目录校验必然失败。
 *  - **先到先得**。主 `User/settings.json` 优先，profile 只补空缺；
 *    否则后遍历到的 profile 会把用户的真实设置覆盖掉。
 */
function seedFromUserSettings(target: AppSettings): boolean {
    const appData = process.env.APPDATA || '';
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const products = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];

    /** 主 settings.json 在前，profile 在后。 */
    const candidates: string[] = [];
    const collect = (userDir: string) => {
        candidates.push(path.join(userDir, 'settings.json'));
        try {
            const profiles = fs.readdirSync(path.join(userDir, 'profiles'), { withFileTypes: true })
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .sort();
            for (const name of profiles) {
                candidates.push(path.join(userDir, 'profiles', name, 'settings.json'));
            }
        } catch { /* 没有 profiles 目录 */ }
    };
    for (const product of products) {
        if (appData) { collect(path.join(appData, product, 'User')); }
        collect(path.join(configRoot, product, 'User'));
    }

    const seeded = new Set<string>();
    for (const file of candidates) {
        let raw: string;
        try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const key of SEEDABLE_KEYS) {
            if (seeded.has(key)) { continue; }
            // 值可以是字符串（含转义）、布尔或数字，统一交给 JSON.parse 反转义。
            const pattern = new RegExp(
                `"wallpaperStudio\\.${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|-?[0-9.]+(?:[eE][-+]?[0-9]+)?)`
            );
            const match = pattern.exec(raw);
            if (!match) { continue; }
            let decoded: unknown;
            try { decoded = JSON.parse(match[1]); } catch { continue; }
            const coerced = coerce(key as keyof AppSettings, decoded);
            if (coerced === undefined) { continue; }
            (target as any)[key] = coerced;
            seeded.add(key);
        }
    }
    return seeded.size > 0;
}

function load(): AppSettings {
    if (cache) { return cache; }
    const settings: AppSettings = { ...DEFAULT_SETTINGS };
    let existed = false;
    let needsMigration = false;
    let cachedVersion = 1;
    try {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        existed = true;
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (key === 'seeded') { continue; }
            const coerced = coerce(key as keyof AppSettings, parsed?.[key]);
            if (coerced !== undefined) { (settings as any)[key] = coerced; }
        }
        settings.seeded = parsed?.seeded === true;
        cachedVersion = Number(parsed?.version ?? 1);
        // v1 的迁移写入了错误的值（未反转义、跨 profile 覆盖），必须重新迁移一次。
        needsMigration = cachedVersion < SETTINGS_VERSION;
    } catch {
        existed = false;
    }

    if (!existed) {
        if (seedFromUserSettings(settings)) {
            settings.seeded = true;
        }
        settings.version = SETTINGS_VERSION;
        cache = settings;
        return settings;
    }

    if (needsMigration) {
        // 只覆盖能从旧 settings.json 里读到的键；UI 里改过、settings.json 里没有的键保持原值。
        seedFromUserSettings(settings);
        if (Number(cachedVersion ?? 1) < 3) {
            // v1/v2 时期的透明度/模糊度来自错误的迁移（数值与用户设置不一致），
            // 统一回到默认值，之后完全由插件 UI 维护。
            settings.opacity = DEFAULT_SETTINGS.opacity;
            settings.blur = DEFAULT_SETTINGS.blur;
        }
        settings.version = SETTINGS_VERSION;
        cache = settings;
        return settings;
    }

    settings.version = SETTINGS_VERSION;
    cache = settings;
    return settings;
}

/**
 * 从磁盘重新读一次（绕过内存缓存）。
 *
 * 设置文件是跨 profile / 跨窗口共享的，多个 VS Code 窗口可能同时在写；
 * 写入前必须以磁盘内容为准做合并，否则窗口 A 的旧快照会把窗口 B 刚改的值覆盖掉。
 */
function reloadFromDisk(): AppSettings {
    const previous = cache;
    cache = null;
    try {
        return load();
    } finally {
        if (!cache) { cache = previous; }
    }
}

function persist(settings: AppSettings): boolean {
    try {
        fs.mkdirSync(SETTINGS_DIR, { recursive: true });
        atomicWriteTextSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
        return true;
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to persist settings:', error);
        return false;
    }
}

/** 读取一份当前设置的浅拷贝。 */
/** 删除设置文件并回到全默认值（「清除所有缓存与配置」用）。 */
export async function resetSettings(): Promise<void> {
    await withSettingsLock(() => {
        const next = { ...DEFAULT_SETTINGS, seeded: true, version: SETTINGS_VERSION };
        if (!persist(next)) { throw new Error('Failed to reset settings'); }
        cache = next;
        changeEmitter.fire(Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'seeded'));
    });
}

async function withSettingsLock<T>(operation: () => T): Promise<T> {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    const release = await lockfile.lock(SETTINGS_FILE, {
        realpath: false,
        retries: { retries: 12, minTimeout: 25, maxTimeout: 250 },
        stale: 5000
    });
    try { return operation(); } finally { await release(); }
}

/** External edits are parsed completely before replacing the live snapshot. */
export function reloadExternalSettings(): void {
    try {
        JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const previous = { ...load() };
        const next = reloadFromDisk();
        const changed = Object.keys(DEFAULT_SETTINGS).filter(key =>
            (previous as any)[key] !== (next as any)[key]);
        if (changed.length) {
            changeEmitter.fire(changed);
            externalChangeEmitter.fire(changed);
        }
    } catch (error) {
        console.warn('[WallpaperStudio] External settings update skipped:', error);
    }
}

/** Polling also survives atomic rename and unavailable native file watchers. */
export function startSettingsSync(): Disposable {
    const listener = () => reloadExternalSettings();
    load();
    fs.watchFile(SETTINGS_FILE, { interval: 750, persistent: false }, listener);
    void withSettingsLock(() => {
        if (fs.existsSync(SETTINGS_FILE)) { JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
        const next = { ...reloadFromDisk() };
        if (!persist(next)) { throw new Error('Failed to initialize settings'); }
        cache = next;
    }).catch(error => console.warn('[WallpaperStudio] Settings initialization failed:', error));
    return { dispose: () => fs.unwatchFile(SETTINGS_FILE, listener) };
}

export function readSettings(): AppSettings {
    return { ...load() };
}

/**
 * `WorkspaceConfiguration` 的鸭子类型替身。
 *
 * 现有的 `PickList` / `FileDom` 都接受 `WorkspaceConfiguration` 并只用到
 * `get` / `update`，所以只要形状一致就能零改动接上共享存储。
 */
export class AppConfig {
    /**
     * 索引签名让 `config.imagePath` 这类写法在**类型层面**合法；
     * 真正的运行时属性在构造函数里用 `Object.defineProperty` 建出来（见下）。
     */
    [key: string]: any;

    constructor() {
        /**
         * VS Code 的 `WorkspaceConfiguration` 既能 `get('key')`，也能直接 `config.key`。
         * 现有代码两种写法都有（例如 `resolveCurrentOpacity(config.opacity)`、
         * `config.imagePath`），而 TypeScript 的索引签名不会生成运行时属性 ——
         * 只声明不定义的话这些访问全部得到 `undefined`：
         *   - `resolveCurrentOpacity(undefined)` → NaN → CSS `opacity: NaN` 无效 →
         *     浏览器回落到 1，背景完全不透明，界面内容全被盖住；
         *   - `config.imagePath` → undefined，启动时误判"没有背景"。
         * 因此这里为每个设置键定义真实的 getter/setter。
         */
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (key === 'seeded' || key === 'version') { continue; }
            Object.defineProperty(this, key, {
                enumerable: true,
                configurable: true,
                get: () => (load() as any)[key],
                set: (value: unknown) => { void this.update(key, value); }
            });
        }
    }

    get<T>(key: string, defaultValue?: T): T {
        const settings = load();
        const name = key.startsWith('wallpaperStudio.') ? key.slice('wallpaperStudio.'.length) : key;
        const value = (settings as any)[name];
        return (value === undefined ? defaultValue : value) as T;
    }

    has(key: string): boolean {
        const name = key.startsWith('wallpaperStudio.') ? key.slice('wallpaperStudio.'.length) : key;
        return (load() as any)[name] !== undefined;
    }

    inspect(section?: string): any {
        const name = (section || '').replace(/^wallpaperStudio\./, '');
        const settings = load();
        return {
            key: name,
            defaultValue: (DEFAULT_SETTINGS as any)[name],
            globalValue: (settings as any)[name]
        };
    }

    async update(key: string, value: unknown, _target?: unknown, _overrideInLanguage?: boolean): Promise<void> {
        const name = (key.startsWith('wallpaperStudio.') ? key.slice('wallpaperStudio.'.length) : key) as keyof AppSettings;
        if (!(name in DEFAULT_SETTINGS) || name === 'seeded') {
            // 未知键：照旧吞掉，避免旧的调用路径抛错。
            return;
        }
        const coerced = coerce(name, value);
        if (coerced === undefined) { return; }
        // 多窗口共享同一个文件：先合并磁盘上的最新内容，再写回自己这一项。
        await withSettingsLock(() => {
            const previous = { ...load() };
            if (fs.existsSync(SETTINGS_FILE)) { JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
            const settings = reloadFromDisk();
            const next = { ...settings, [name]: coerced };
            if ((settings as any)[name] !== coerced && !persist(next)) {
                throw new Error(`Failed to save setting: ${name}`);
            }
            cache = next;
            const changed = Object.keys(DEFAULT_SETTINGS).filter(key =>
                (previous as any)[key] !== (next as any)[key]);
            if (changed.length) { changeEmitter.fire(changed); }
            const external = changed.filter(key => key !== name);
            if (external.length) { externalChangeEmitter.fire(external); }
        });
    }
}

const instance = new AppConfig();

/** 全局单例，可直接替换 `workspace.getConfiguration('wallpaperStudio')`。 */
export function getAppConfig(): AppConfig {
    return instance;
}

/** 兼容旧代码：有些地方还会用 `workspace.getConfiguration`，这里给出统一入口。 */
export const appConfig = instance;

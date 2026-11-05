import { reactive } from 'vue';
import type { SceneRenderConfig } from '../../../src/sceneRender';


/**
 * Reactive snapshot of extension-side configuration mirrored into the webview.
 * The extension pushes a 'state' message; the bridge listener writes here.
 */
export interface StudioConfig {
    opacity: number;
    blur: number;
    imagePath: string;
    imagePathDisplay: string;     // webview URI for <img src>
    imagePathLabel: string;
    /** 当前背景（三种来源通用）的完整 Wallpaper Engine 配置项 */
    imageProperties: WallpaperProperty[];
    /** 当前背景的项目声明（交给场景渲染器，缺了它属性值绑不回画面） */
    imageProject?: unknown;
    sceneRender?: SceneRenderConfig;
    autoStatus: boolean;
    autoInterval: number;
    sizeModel: string;
    blendModel: string;
    randomImageFolder: string;
    /** false = 所有窗口共用一张背景图（旧版行为） */
    perWindowBackground: boolean;
}

export interface StudioState {
    sourceMode: 'file' | 'folder' | 'wallpaper';
    recentImages: Array<{ path: string; display: string; name: string; properties?: WallpaperProperty[] }>;
    folderImages: Array<{ path: string; display: string; name: string; properties?: WallpaperProperty[] }>;
    folderImagesTotal: number;
    wallpaperConfigPath: string;
    wallpaperConfigEnabled: boolean;
    /** 播放列表为空时的具体原因（只在 wallpaper 模式有值）。 */
    wallpaperNotice?: string;
    wallpaperLoading: boolean;
    wallpaperLoaded: number;
    wallpaperTotal: number;
    /** 扩展侧是否已经完成过一次播放列表读取；false 时面板必须显示加载态。 */
    wallpaperLoadedOnce: boolean;
    wallpaperPlaylist: Array<{
        path: string;
        title: string;
        description: string;
        preview: string;
        mediaSource: string;
        sceneSource: string;
        active: boolean;
        properties: Array<{
            key: string;
            type: string;
            text: string;
            value: unknown;
            min?: number;
            max?: number;
            step?: number;
            options?: Array<{ label: string; value: string }>;
        }>;
    }>;
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

export const config = reactive<StudioConfig>({
    opacity: 0.2,
    blur: 0,
    imagePath: '',
    imagePathDisplay: '',
    imagePathLabel: '',
    imageProperties: [],
    imageProject: undefined,
    autoStatus: false,
    autoInterval: 0,
    sizeModel: 'cover',
    blendModel: 'auto',
    randomImageFolder: '',
    perWindowBackground: true,
});

export const state = reactive<StudioState>({
    sourceMode: 'file',
    recentImages: [],
    folderImages: [],
    folderImagesTotal: 0,
    wallpaperConfigPath: '',
    wallpaperConfigEnabled: false,
    wallpaperNotice: '',
    wallpaperLoading: false,
    wallpaperLoaded: 0,
    wallpaperTotal: 0,
    wallpaperLoadedOnce: false,
    wallpaperPlaylist: []
});

export interface StudioBrand {
    logo: string;
    name: string;
}

export const brand = reactive<StudioBrand>({
    logo: '',
    name: ''
});

/**
 * 本地正在编辑（防抖发送中/刚发送）的字段 → 失效时间戳。
 * 扩展回推的完整 state 会跳过这些字段，避免覆盖用户正在拖动的值。
 */
type DirtyScope = 'config' | 'state';
const dirtyUntil: Record<DirtyScope, Map<string, number>> = {
    config: new Map(),
    state: new Map()
};

export function markDirty(scope: DirtyScope, key: string, ms: number) {
    const until = Date.now() + ms;
    const map = dirtyUntil[scope];
    if ((map.get(key) ?? 0) < until) { map.set(key, until); }
}

function isDirty(scope: DirtyScope, key: string): boolean {
    const map = dirtyUntil[scope];
    const until = map.get(key);
    if (until === undefined) { return false; }
    if (Date.now() < until) { return true; }
    map.delete(key);
    return false;
}

function assignClean(scope: DirtyScope, target: Record<string, any>, src: Record<string, any>) {
    for (const k of Object.keys(src)) {
        if (!isDirty(scope, k)) { target[k] = src[k]; }
    }
}

export function applyState(data: any) {
    if (!data) { return; }
    if (data.config) { assignClean('config', config, data.config); }
    if (data.state)  { assignClean('state', state, data.state); }
    if (typeof data.brandLogo === 'string') { brand.logo = data.brandLogo; }
    if (typeof data.brandName === 'string') { brand.name = data.brandName; }
}

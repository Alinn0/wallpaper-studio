/**
 * Protocol shared by the extension host and the Vue webview.
 *
 * Keep values that cross the webview boundary here so the two build targets
 * cannot silently drift apart.
 */

export const ActionType = {
    SelectPictures: 1,
    AddDirectory: 2,
    ManualSelection: 3,
    UpdateBackground: 4,
    BackgroundOpacity: 5,
    InputPath: 6,
    CloseBackground: 7,
    ReloadWindow: 8,
    CloseMenu: 9,
    MoreMenu: 12,
    OpenExternalUrl: 13,
    OpenFilePath: 14,
    SizeModeMenu: 15,
    SetSizeMode: 16,
    BackgroundBlur: 18,
    AutoRandomSettings: 20,
    OpenCacheFolder: 21
} as const;

export type ActionTypeValue = typeof ActionType[keyof typeof ActionType];

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'loadGallery' }
    | { type: 'runAction'; action: number; path?: string }
    | { type: 'setConfig'; key: string; value: unknown }
    | { type: 'saveDisplayFps'; maxFps: number; overwrite: boolean }
    | { type: 'setGlobalState'; key: string; value: unknown }
    | { type: 'setSourceMode'; mode: 'file' | 'folder' | 'wallpaper' }
    | { type: 'selectWallpaperConfig' }
    | { type: 'reloadWallpaperConfig' }
    | { type: 'randomWallpaper' }
    | { type: 'previousWallpaper' }
    | { type: 'useWallpaper'; path: string }
    | { type: 'setWallpaperPinned'; path: string; pinned: boolean }
    | { type: 'removeWallpaper'; path: string }
    | { type: 'removePlaylistItem'; path: string; mode: 'file' | 'folder' | 'wallpaper' }
    | { type: 'revealInExplorer'; path: string }
    | { type: 'setWallpaperProperty'; path: string; key: string; value: unknown }
    | { type: 'setWallpaperProperties'; path: string; properties: Record<string, unknown> }
    | { type: 'cacheThumbnail'; key: string; value: string }
    | { type: 'readThumbnails'; keys: string[]; requestId: number }
    | { type: 'scenePreviewPage' }
    | { type: 'openExternal'; url: string }
    | { type: 'resetAll' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
    if (!isRecord(value)) { return false; }
    const text = (key: string) => typeof value[key] === 'string';
    const mode = () => ['file', 'folder', 'wallpaper'].includes(value.mode as string);
    const hasValue = () => Object.prototype.hasOwnProperty.call(value, 'value');
    switch (value.type) {
        case 'ready': case 'refresh': case 'loadGallery':
        case 'selectWallpaperConfig': case 'reloadWallpaperConfig':
        case 'randomWallpaper': case 'previousWallpaper':
        case 'scenePreviewPage': case 'resetAll': return true;
        case 'runAction':
            return Object.values(ActionType).includes(value.action as ActionTypeValue)
                && (value.path === undefined || text('path'));
        case 'setConfig': case 'setGlobalState': return text('key') && hasValue();
        case 'saveDisplayFps':
            return typeof value.maxFps === 'number' && Number.isFinite(value.maxFps)
                && value.maxFps > 0 && typeof value.overwrite === 'boolean';
        case 'setSourceMode': return mode();
        case 'useWallpaper': case 'removeWallpaper': case 'revealInExplorer': return text('path');
        case 'setWallpaperPinned': return text('path') && typeof value.pinned === 'boolean';
        case 'removePlaylistItem': return text('path') && mode();
        case 'setWallpaperProperty': return text('path') && text('key') && hasValue();
        case 'setWallpaperProperties': return text('path') && isRecord(value.properties);
        case 'cacheThumbnail': return text('key') && text('value');
        case 'readThumbnails':
            return Array.isArray(value.keys) && value.keys.every(key => typeof key === 'string')
                && Number.isSafeInteger(value.requestId);
        case 'openExternal': return text('url') && (value.url as string).toLowerCase().startsWith('https://');
        default: return false;
    }
}

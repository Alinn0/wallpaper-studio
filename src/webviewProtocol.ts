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
    | { type: 'setGlobalState'; key: string; value: unknown }
    | { type: 'setSourceMode'; mode: 'file' | 'folder' | 'wallpaper' }
    | { type: 'clearRecentImages' }
    | { type: 'selectWallpaperConfig' }
    | { type: 'reloadWallpaperConfig' }
    | { type: 'randomWallpaper' }
    | { type: 'previousWallpaper' }
    | { type: 'useWallpaper'; path: string }
    | { type: 'removeWallpaper'; path: string }
    | { type: 'removePlaylistItem'; path: string; mode: 'file' | 'folder' | 'wallpaper' }
    | { type: 'revealInExplorer'; path: string }
    | { type: 'setWallpaperProperty'; path: string; key: string; value: unknown }
    | { type: 'setWallpaperProperties'; path: string; properties: Record<string, unknown> }
    | { type: 'cacheThumbnail'; key: string; value: string }
    | { type: 'scenePreviewPage' }
    | { type: 'openExternal'; url: string }
    | { type: 'resetAll' };

export function isWebviewMessage(value: unknown): value is WebviewMessage {
    return typeof value === 'object'
        && value !== null
        && typeof (value as { type?: unknown }).type === 'string';
}

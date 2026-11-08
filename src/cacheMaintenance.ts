import { clearWallpaperSceneCache } from './wallpaperScene';
import { clearWallpaperScenePreview } from './scenePreview';
import { disposeSceneTransport } from './sceneTransport';
import { ThumbnailStore } from './thumbnailStore';
import { CACHE_ROOT } from './cachePaths';
import * as fs from 'fs';
import * as path from 'path';
import { clearPlaylistSnapshot } from './playlistSnapshot';

export async function backupWallpaperState(): Promise<string> {
    const directory = path.join(CACHE_ROOT, 'backups', 'reset-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
    await fs.promises.mkdir(directory, { recursive: true });
    for (const name of ['settings.json', 'library.json', 'runtime.json']) {
        const file = path.join(CACHE_ROOT, name);
        if (fs.existsSync(file)) { await fs.promises.copyFile(file, path.join(directory, name)); }
    }
    return directory;
}

/** Delete only generated cache files, using the same locks as their writers. */
export async function clearAllWallpaperCaches(): Promise<void> {
    clearPlaylistSnapshot();
    disposeSceneTransport();
    await clearWallpaperSceneCache();
    await new ThumbnailStore(CACHE_ROOT).clear();
    await clearWallpaperScenePreview();
}

import * as os from 'os';
import * as path from 'path';

/** All persistent plugin caches share one root across profiles and workspaces. */
export const CACHE_ROOT = process.env.WALLPAPER_STUDIO_DATA_DIR || path.join(os.homedir(), '.wallpaper-studio');
export const SCENE_CACHE_DIR = path.join(CACHE_ROOT, 'scene-assets');

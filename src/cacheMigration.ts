import * as fs from 'fs';
import * as path from 'path';
import { CACHE_ROOT } from './cachePaths';
import { ThumbnailStore } from './thumbnailStore';

/** Import optional thumbnails without touching preferences or original media. */
export async function migrateLegacyThumbnails(legacyRoot: string | undefined): Promise<void> {
    if (!legacyRoot || path.resolve(legacyRoot) === path.resolve(CACHE_ROOT) ||
        !fs.existsSync(path.join(legacyRoot, 'thumbnails', 'index.json'))) { return; }
    const old = new ThumbnailStore(legacyRoot);
    const target = new ThumbnailStore(CACHE_ROOT);
    const existing = await target.snapshot();
    const previous = await old.snapshot();
    // Current shared data wins; don't overwrite a newer thumbnail with a legacy profile.
    const missing = Object.entries(previous).filter(([key]) => !existing[key]);
    await target.setMany(missing);
    const restored = await target.snapshot();
    if (missing.every(([key, value]) => restored[key] === value)) { await old.clear(); }
}

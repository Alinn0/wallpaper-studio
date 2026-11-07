/**
 * Detect whether a path points at a video file based on its extension.
 * Used to decide between <img> and <video> in previews.
 */
import { isVideoFile } from '../../../src/mediaTypes';

export function isVideoPath(p: string | undefined | null): boolean {
    if (!p) { return false; }
    return isVideoFile(p);
}

export function isWallpaperPkgPath(p: string | undefined | null): boolean {
    if (!p) { return false; }
    const clean = p.split(/[?#]/)[0].toLowerCase();
    return clean.endsWith('.pkg');
}

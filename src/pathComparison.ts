import * as path from 'path';

/** Stable comparison key for Windows paths, independent of slash style/case. */
export function normalizeComparablePath(value: string): string {
    return path.normalize(value).replace(/\//g, '\\').toLowerCase();
}

export function samePath(a: string, b: string): boolean {
    return normalizeComparablePath(a) === normalizeComparablePath(b);
}

/** Returns true only for descendants, not the folder itself. */
export function isPathInsideFolder(value: string, folder: string): boolean {
    if (!folder) { return false; }
    const item = normalizeComparablePath(value);
    const root = normalizeComparablePath(folder).replace(/[\\]+$/, '') + '\\';
    return item.startsWith(root);
}

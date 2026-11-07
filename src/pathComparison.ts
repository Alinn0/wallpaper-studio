import * as path from 'path';

/** Preserve case on case-sensitive platforms; accept either slash style on Windows. */
export function normalizeComparablePath(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.replace(/\//g, '\\').toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
    return normalizeComparablePath(a) === normalizeComparablePath(b);
}

/** Returns true only for descendants, not the folder itself. */
export function isPathInsideFolder(value: string, folder: string): boolean {
    if (!folder) { return false; }
    const item = normalizeComparablePath(value);
    const separator = process.platform === 'win32' ? '\\' : '/';
    const root = normalizeComparablePath(folder).replace(/[\\/]+$/, '') + separator;
    return item.startsWith(root);
}

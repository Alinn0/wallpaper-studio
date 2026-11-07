/** Shared by the extension and the webview; decoding still depends on Chromium. */
export const VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v', '.mkv', '.avi'];
export const MEDIA_EXTS = [
    '.svg', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.jfif',
    ...VIDEO_EXTS, '.pkg'
];

export function isVideoFile(name: string): boolean {
    const clean = name.toLowerCase().split(/[?#]/)[0];
    return VIDEO_EXTS.some(ext => clean.endsWith(ext));
}

/** Browser-side identity for a native media path, without importing Node APIs. */
export function mediaPathKey(value: string): string {
    return /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? value.replace(/\\/g, '/').toLowerCase() : value;
}

/*
 * 纯字符串的补丁清理工具，不依赖 vscode API。
 * FileDom（运行时）和 uninstall.ts（vscode:uninstall 钩子，无 vscode 环境）共用，
 * 保证安装/卸载对同一份标记的理解一致。
 */

export const EXT_NAME = 'wallpaperStudio';
export const CUSTOM_CSS_FILE_PREFIX = 'css-wallpaper-studio';
export const CUSTOM_JS_FILE_NAME = 'js-wallpaper-studio.js';
export const CUSTOM_WEBWALLGL_FILE_NAME = 'wallpaper-studio-webwallgl.js';
export const CUSTOM_SCENE_HTML_FILE_NAME = 'wallpaper-studio-scene.html';
export const CUSTOM_SCENE_JS_FILE_NAME = 'wallpaper-studio-scene.js';
export const CUSTOM_ASSET_DIR_NAME = 'wallpaper-studio-assets';
export const CSP_MEDIA_PATCH_START = '/*wallpaper-studio-media-csp-start*/';
export const CSP_MEDIA_PATCH_END = '/*wallpaper-studio-media-csp-end*/';
export const CSP_IMAGE_PATCH_START = '/*wallpaper-studio-image-csp-start*/';
export const CSP_IMAGE_PATCH_END = '/*wallpaper-studio-image-csp-end*/';
export const CSP_FRAME_PATCH_START = '/*wallpaper-studio-frame-csp-start*/';
export const CSP_FRAME_PATCH_END = '/*wallpaper-studio-frame-csp-end*/';
export const CSP_FRAME_DIRECTIVE_PATCH_START = '/*wallpaper-studio-frame-directive-csp-start*/';
export const CSP_FRAME_DIRECTIVE_PATCH_END = '/*wallpaper-studio-frame-directive-csp-end*/';
export const HTML_CACHE_BUST_PARAM = 'wallpaper-studio';

export const CODE_SERVER_WORKBENCH_SCRIPT_RE =
    /(<script\b[^>]*\bsrc=["'])([^"']*\/out\/vs\/code\/browser\/workbench\/workbench\.js(?:\?[^"']*)?)(["'][^>]*>\s*<\/script>)/g;

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const PATCH_BLOCK_RE = new RegExp(
    `${escapeRegExp(`/*ext-${EXT_NAME}-start*/`)}[\\s\\S]*?${escapeRegExp(`/*ext-${EXT_NAME}-end*/`)}`,
    'g'
);

/** 去掉 JS bundle 里的 loader 标记块。 */
export function clearPatchBlock(content: string): string {
    return content.replace(PATCH_BLOCK_RE, '').trim();
}

export function hasPatchBlock(content: string): boolean {
    PATCH_BLOCK_RE.lastIndex = 0;
    const found = PATCH_BLOCK_RE.test(content);
    PATCH_BLOCK_RE.lastIndex = 0;
    return found;
}

export function patchMediaCsp(content: string): string {
    let patched = content;
    if (patched.indexOf(CSP_MEDIA_PATCH_START) === -1) {
        // 只在 `media-src 'self'` 之后插入，`;` 留在原处，避免把后续指令并进 media-src。
        patched = patched.replace(/media-src\s+'self'/g, (m) => `${m} ${CSP_MEDIA_PATCH_START} blob: data: ${CSP_MEDIA_PATCH_END}`);
    }
    if (patched.indexOf(CSP_IMAGE_PATCH_START) === -1) {
        // WebGL scene textures may be decoded from Blob URLs created by WebWallGL.
        patched = patched.replace(/img-src\s+[^;]+/g, (m) =>
            /\bblob:/.test(m) ? m : `${m} ${CSP_IMAGE_PATCH_START} blob: ${CSP_IMAGE_PATCH_END}`);
    }
    if (
        patched.indexOf(CSP_FRAME_PATCH_START) === -1 &&
        patched.indexOf(CSP_FRAME_DIRECTIVE_PATCH_START) === -1
    ) {
        patched = patched.replace(/frame-src\s+[^;]+/g, (m) =>
            /\bvscode-file:/.test(m) ? m : `${m} ${CSP_FRAME_PATCH_START} vscode-file: ${CSP_FRAME_PATCH_END}`);
        if (patched.indexOf(CSP_FRAME_PATCH_START) === -1) {
            patched = patched.replace(/default-src\s+'none'/g,
                (m) => `${m}; ${CSP_FRAME_DIRECTIVE_PATCH_START} frame-src 'self' vscode-file: ${CSP_FRAME_DIRECTIVE_PATCH_END}`);
        }
    }
    return patched;
}

const CSP_MEDIA_RESTORE_RE = new RegExp(
    `\\s*${escapeRegExp(CSP_MEDIA_PATCH_START)}\\s*blob:\\s*data:\\s*${escapeRegExp(CSP_MEDIA_PATCH_END)}`,
    'g'
);
const CSP_IMAGE_RESTORE_RE = new RegExp(
    `\\s*${escapeRegExp(CSP_IMAGE_PATCH_START)}\\s*blob:\\s*${escapeRegExp(CSP_IMAGE_PATCH_END)}`,
    'g'
);
const CSP_FRAME_RESTORE_RE = new RegExp(
    `\\s*${escapeRegExp(CSP_FRAME_PATCH_START)}\\s*vscode-file:\\s*${escapeRegExp(CSP_FRAME_PATCH_END)}`,
    'g'
);
const CSP_FRAME_DIRECTIVE_RESTORE_RE = new RegExp(
    `;\\s*${escapeRegExp(CSP_FRAME_DIRECTIVE_PATCH_START)}\\s*frame-src\\s+'self'\\s+vscode-file:\\s*${escapeRegExp(CSP_FRAME_DIRECTIVE_PATCH_END)}`,
    'g'
);

export function restoreMediaCsp(content: string): string {
    return content
        .replace(CSP_MEDIA_RESTORE_RE, '')
        .replace(CSP_IMAGE_RESTORE_RE, '')
        .replace(CSP_FRAME_DIRECTIVE_RESTORE_RE, '')
        .replace(CSP_FRAME_RESTORE_RE, '');
}

function splitScriptUrl(scriptUrl: string): { base: string; params: string[]; hash: string; hasQuery: boolean } {
    const hashIndex = scriptUrl.indexOf('#');
    const hash = hashIndex === -1 ? '' : scriptUrl.substring(hashIndex);
    const urlWithoutHash = hashIndex === -1 ? scriptUrl : scriptUrl.substring(0, hashIndex);
    const queryIndex = urlWithoutHash.indexOf('?');
    const base = queryIndex === -1 ? urlWithoutHash : urlWithoutHash.substring(0, queryIndex);
    const query = queryIndex === -1 ? '' : urlWithoutHash.substring(queryIndex + 1);
    const paramPrefix = `${HTML_CACHE_BUST_PARAM}=`;
    const params = query.split('&').filter((param) => param && !param.startsWith(paramPrefix));
    return { base, params, hash, hasQuery: queryIndex !== -1 };
}

export function withHtmlCacheBust(scriptUrl: string, cacheKey: string): string {
    const { base, params, hash } = splitScriptUrl(scriptUrl);
    params.push(`${HTML_CACHE_BUST_PARAM}=${encodeURIComponent(cacheKey)}`);
    return `${base}?${params.join('&')}${hash}`;
}

export function withoutHtmlCacheBust(scriptUrl: string): string {
    const { base, params, hash, hasQuery } = splitScriptUrl(scriptUrl);
    if (!hasQuery) {
        return scriptUrl;
    }
    return `${base}${params.length ? `?${params.join('&')}` : ''}${hash}`;
}

export function patchCodeServerWorkbenchHtml(content: string, cacheKey: string): string {
    return content.replace(CODE_SERVER_WORKBENCH_SCRIPT_RE, (_m: string, prefix: string, url: string, suffix: string) =>
        `${prefix}${withHtmlCacheBust(url, cacheKey)}${suffix}`);
}

export function clearCodeServerWorkbenchHtmlPatch(content: string): string {
    return content.replace(CODE_SERVER_WORKBENCH_SCRIPT_RE, (_m: string, prefix: string, url: string, suffix: string) =>
        `${prefix}${withoutHtmlCacheBust(url)}${suffix}`);
}

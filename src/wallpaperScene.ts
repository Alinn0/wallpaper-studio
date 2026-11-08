import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteTextSync } from './atomicWrite';
import { SCENE_CACHE_DIR } from './cachePaths';
import { acquireFileLock, checkCancellation, copyFileCancellable } from './cancellation';

const WEBWALLGL_PLACEHOLDER = '__WALLPAPER_STUDIO_WEBWALLGL_BASE64__';
const SCENE_PLACEHOLDER = '__WALLPAPER_STUDIO_SCENE_BASE64__';
const COVER_ALIGN_PATCH_MARKER = '/* wallpaper-studio-cover-align */';

/**
 * WebWallGL 已经在场景渲染器内部使用 coverAlign 计算投影窗口，但 3.0.0
 * 没有把它暴露给宿主。只给内联运行时补一个极小的实例方法，避免通过
 * DOM 尺寸/缩放模拟视角移动。
 */
export function patchWallpaperSceneRuntime(runtime: string): string {
    if (runtime.indexOf(COVER_ALIGN_PATCH_MARKER) !== -1) { return runtime; }
    // 运行时里可能有多个 setProperties；只认把属性转发给 sceneCtl / liveUserProps 的
    // 实例方法，否则会把「另一个方法的形参」误当成运行时对象。
    const methodRegex = /setProperties\(([A-Za-z_$][\w$]*)\)\s*\{/g;
    let match: RegExpExecArray | null;
    let index = -1;
    let receiver = '';
    while ((match = methodRegex.exec(runtime))) {
        const body = runtime.slice(match.index, match.index + 600);
        const owner = /([A-Za-z_$][\w$]*)\.(?:sceneCtl\??\.applyUserProperties|liveUserProps)/.exec(body);
        if (!owner) { continue; }
        index = match.index;
        receiver = owner[1];
        break;
    }
    if (index === -1 || !receiver) {
        throw new Error('WebWallGL runtime does not expose a patchable scene instance API.');
    }
    const method = `${COVER_ALIGN_PATCH_MARKER}
    setCoverAlign(x, y) {
      const ax = Math.max(0, Math.min(1, Number(x) || 0));
      const ay = Math.max(0, Math.min(1, Number(y) || 0));
      ${receiver}.coverAlign.x = ax;
      ${receiver}.coverAlign.y = ay;
      ${receiver}.coverAlign.tx = ax;
      ${receiver}.coverAlign.ty = ay;
      // 视频/图片类型的 DOM 渲染路径靠 object-position 生效，只改数值不会重排。
      const dom = ${receiver}.video || ${receiver}.img;
      if (dom && dom.style) {
        dom.style.objectPosition = (ax * 100).toFixed(2) + '% ' + (ay * 100).toFixed(2) + '%';
      }
    },
    `;
    return runtime.slice(0, index) + method + runtime.slice(index);
}

function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
    checkCancellation(signal);
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        const abort = () => stream.destroy(new Error('Scene preparation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        stream.once('close', () => signal?.removeEventListener('abort', abort));
        stream.on('data', (chunk: Buffer) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function replaceSinglePlaceholder(template: string, placeholder: string, value: string): string {
    const index = template.indexOf(placeholder);
    if (index === -1 || template.indexOf(placeholder, index + placeholder.length) !== -1) {
        throw new Error(`Wallpaper scene template must contain exactly one ${placeholder} placeholder.`);
    }
    return template.slice(0, index) + value + template.slice(index + placeholder.length);
}

export function buildWallpaperSceneHtml(template: string, webwallglRuntime: string, sceneScript: string): string {
    const withRuntime = replaceSinglePlaceholder(
        template,
        WEBWALLGL_PLACEHOLDER,
        Buffer.from(webwallglRuntime, 'utf8').toString('base64')
    );
    return replaceSinglePlaceholder(
        withRuntime,
        SCENE_PLACEHOLDER,
        Buffer.from(sceneScript, 'utf8').toString('base64')
    );
}

interface PackageRecord { source: string; signature: string; hash: string; size: number; usedAt: number; }
const PACKAGE_NAME = /^wallpaper-scene-[a-f0-9]{64}\.pkg$/;
export const MAX_SCENE_PACKAGES = 5;

export async function copyWallpaperScenePackage(
    sourcePath: string,
    assetDirectory = SCENE_CACHE_DIR,
    signal?: AbortSignal
): Promise<string> {
    return useWallpaperScenePackage(sourcePath, assetDirectory, file => Promise.resolve(file), signal);
}

/** Hold the cross-process cache lock until bytes have been read, even on Windows. */
export async function readWallpaperScenePackage(sourcePath: string, signal?: AbortSignal): Promise<Buffer> {
    return useWallpaperScenePackage(sourcePath, SCENE_CACHE_DIR, file => fs.promises.readFile(file, { signal }), signal);
}

async function useWallpaperScenePackage<T>(sourcePath: string, assetDirectory: string, use: (file: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkCancellation(signal);
    await fs.promises.mkdir(assetDirectory, { recursive: true });
    const release = await acquireFileLock(assetDirectory, signal);
    let unpublishedAsset: string | undefined;
    try {
        const indexPath = path.join(assetDirectory, 'index.json');
        let records: PackageRecord[] = [];
        try {
            const parsed = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            if (Array.isArray(parsed)) {
                records = parsed.filter(r => r && /^[a-f0-9]{64}$/.test(r.hash) &&
                    typeof r.source === 'string' && typeof r.signature === 'string' &&
                    Number.isFinite(r.size) && Number.isFinite(r.usedAt));
            }
        } catch { /* A missing/corrupt cache index is rebuilt from originals. */ }
        const source = path.resolve(sourcePath);
        const stat = await fs.promises.stat(source);
        const signatureOf = (s: fs.Stats) => `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
        const signature = signatureOf(stat);
        const previous = records.find(r => r.source === source && r.signature === signature);
        const hash = previous?.hash || await hashFile(source, signal);
        const assetPath = path.join(assetDirectory, `wallpaper-scene-${hash}.pkg`);
        let valid = false;
        try { valid = (await fs.promises.stat(assetPath)).size === stat.size; } catch { /* Recreate evicted cache. */ }
        if (!valid) {
            const temporary = `${assetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            try {
                await copyFileCancellable(source, temporary, signal);
                if (signatureOf(await fs.promises.stat(source)) !== signature || await hashFile(temporary, signal) !== hash) {
                    throw new Error('Scene package changed while preparing it; retry the wallpaper.');
                }
                await fs.promises.rename(temporary, assetPath);
                unpublishedAsset = assetPath;
            } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
        }
        checkCancellation(signal);
        const usedAt = Math.max(Date.now(), ...records.map(r => r.usedAt + 1));
        records = [{ source, signature, hash, size: stat.size, usedAt },
            ...records.filter(r => r.hash !== hash).sort((a, b) => b.usedAt - a.usedAt)].slice(0, MAX_SCENE_PACKAGES);
        atomicWriteTextSync(indexPath, JSON.stringify(records));
        unpublishedAsset = undefined;
        const keep = new Set(records.map(r => `wallpaper-scene-${r.hash}.pkg`));
        for (const name of await fs.promises.readdir(assetDirectory)) {
            // Never remove source files or unrelated files, including in a custom directory.
            if ((PACKAGE_NAME.test(name) && !keep.has(name)) || /^wallpaper-scene-[a-f0-9]{64}\.pkg\..+\.tmp$/.test(name) ||
                /^index\.json\..+\.tmp$/.test(name)) {
                await fs.promises.unlink(path.join(assetDirectory, name));
            }
        }
        const legacyIndexes = path.join(assetDirectory, '.sources');
        try {
            for (const name of await fs.promises.readdir(legacyIndexes)) {
                if (/^[a-f0-9]{64}\.json(?:\..+\.tmp)?$/.test(name)) {
                    await fs.promises.unlink(path.join(legacyIndexes, name));
                }
            }
            await fs.promises.rmdir(legacyIndexes);
        } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) { throw error; }
        }
        checkCancellation(signal);
        return await use(assetPath);
    } finally {
        try { if (unpublishedAsset) { await fs.promises.unlink(unpublishedAsset); } }
        finally { await release(); }
    }
}

export async function clearWallpaperSceneCache(): Promise<void> {
    await fs.promises.mkdir(SCENE_CACHE_DIR, { recursive: true });
    const release = await acquireFileLock(SCENE_CACHE_DIR);
    try {
        for (const name of await fs.promises.readdir(SCENE_CACHE_DIR)) {
            if (PACKAGE_NAME.test(name) || name === 'index.json' || /^(?:index\.json|wallpaper-scene-[a-f0-9]{64}\.pkg)\..+\.tmp$/.test(name)) {
                await fs.promises.unlink(path.join(SCENE_CACHE_DIR, name));
            }
        }
    } finally { await release(); }
}

export interface WallpaperSceneInputs {
    template: string;
    runtime: string;
    sceneScript: string;
}

const inputCache = new Map<string, { signature: string; value: Promise<WallpaperSceneInputs> }>();
const pageCache = new WeakMap<WallpaperSceneInputs, { html: string; stamp: string }>();

/**
 * 读取生成场景页所需的三个输入：iframe 模板、WebWallGL 运行时（全局构建）与
 * iframe 内运行脚本。workbench 注入与 Studio 预览页共用这一份，保证两处画面
 * 一致（预览拿到的首帧就是背景上渲染的那一帧）。
 */
export async function loadWallpaperSceneInputs(extensionPath: string): Promise<WallpaperSceneInputs> {
    const runtimePath = path.join(require.resolve('webwallgl/package.json'), '..', 'webwallgl.global.min.js');
    const resourcesPath = path.join(extensionPath, 'resources');
    const files = [runtimePath, path.join(resourcesPath, 'wallpaper-scene.html'), path.join(resourcesPath, 'wallpaper-scene.js')];
    const stats = await Promise.all(files.map(file => fs.promises.stat(file)));
    const signature = stats.map(stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).join('|');
    const cached = inputCache.get(extensionPath);
    if (cached && cached.signature === signature) { return cached.value; }
    const value = Promise.all(files.map(file => fs.promises.readFile(file, 'utf8')))
        .then(([runtime, template, sceneScript]) => ({ template, runtime: patchWallpaperSceneRuntime(runtime), sceneScript }));
    inputCache.set(extensionPath, { signature, value });
    try { return await value; } catch (error) { inputCache.delete(extensionPath); throw error; }
}

/**
 * 生成场景页内容，并把三个输入的 sha256 一起返回，调用方据此判断缓存是否过期。
 */
export async function buildWallpaperScenePage(
    extensionPath: string
): Promise<{ html: string; stamp: string }> {
    const inputs = await loadWallpaperSceneInputs(extensionPath);
    const cached = pageCache.get(inputs);
    if (cached) { return cached; }
    const stamp = crypto.createHash('sha256')
        .update(inputs.template).update('\0')
        .update(inputs.runtime).update('\0')
        .update(inputs.sceneScript)
        .digest('hex');
    const result = { html: buildWallpaperSceneHtml(inputs.template, inputs.runtime, inputs.sceneScript), stamp };
    pageCache.set(inputs, result);
    return result;
}

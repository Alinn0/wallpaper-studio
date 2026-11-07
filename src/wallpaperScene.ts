import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteTextSync } from './atomicWrite';

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

function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
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

const packageHashes = new Map<string, { signature: string; hash: Promise<string> }>();

export async function copyWallpaperScenePackage(
    sourcePath: string,
    assetDirectory: string,
    indexDirectory = path.join(assetDirectory, '.sources')
): Promise<string> {
    const stat = await fs.promises.stat(sourcePath);
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const key = path.resolve(sourcePath);
    const indexPath = path.join(indexDirectory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
    let writeIndex = false;
    let cached = packageHashes.get(key);
    if (!cached || cached.signature !== signature) {
        let persistedHash = '';
        try {
            const record = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
            if (record.signature === signature && /^[a-f0-9]{64}$/.test(record.hash)) { persistedHash = record.hash; }
        } catch { /* Cold source or invalid cache: hash the package once. */ }
        writeIndex = !persistedHash;
        cached = { signature, hash: persistedHash ? Promise.resolve(persistedHash) : hashFile(sourcePath) };
        if (packageHashes.size >= 64) { packageHashes.delete(packageHashes.keys().next().value as string); }
        packageHashes.set(key, cached);
    }
    let hash: string;
    try { hash = await cached.hash; } catch (error) {
        packageHashes.delete(key);
        throw error;
    }
    await fs.promises.mkdir(assetDirectory, { recursive: true });
    const assetPath = path.join(assetDirectory, `wallpaper-scene-${hash}.pkg`);
    try {
        if ((await fs.promises.stat(assetPath)).size === stat.size) {
            if (writeIndex) {
                try { atomicWriteTextSync(indexPath, JSON.stringify({ signature, hash })); } catch { /* Cache metadata is optional. */ }
            }
            return assetPath;
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
    const temporary = `${assetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.promises.copyFile(sourcePath, temporary);
        const after = await fs.promises.stat(sourcePath);
        if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== signature) {
            packageHashes.delete(key);
            throw new Error('Scene package changed while preparing it; retry the wallpaper.');
        }
        await fs.promises.rename(temporary, assetPath);
        try { atomicWriteTextSync(indexPath, JSON.stringify({ signature, hash })); } catch { /* Live asset is still usable. */ }
    } finally {
        await fs.promises.unlink(temporary).catch(() => undefined);
    }
    return assetPath;
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

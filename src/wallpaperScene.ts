import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

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

export async function copyWallpaperScenePackage(sourcePath: string, assetDirectory: string): Promise<string> {
    const hash = await hashFile(sourcePath);
    await fs.promises.mkdir(assetDirectory, { recursive: true });
    const assetPath = path.join(assetDirectory, `wallpaper-scene-${hash}.pkg`);
    await fs.promises.copyFile(sourcePath, assetPath);
    return assetPath;
}

export interface WallpaperSceneInputs {
    template: string;
    runtime: string;
    sceneScript: string;
}

/**
 * 读取生成场景页所需的三个输入：iframe 模板、WebWallGL 运行时（全局构建）与
 * iframe 内运行脚本。workbench 注入与 Studio 预览页共用这一份，保证两处画面
 * 一致（预览拿到的首帧就是背景上渲染的那一帧）。
 */
export async function loadWallpaperSceneInputs(extensionPath: string): Promise<WallpaperSceneInputs> {
    const runtimePath = path.join(require.resolve('webwallgl/package.json'), '..', 'webwallgl.global.min.js');
    const resourcesPath = path.join(extensionPath, 'resources');
    const [runtime, template, sceneScript] = await Promise.all([
        fs.promises.readFile(runtimePath, 'utf8'),
        fs.promises.readFile(path.join(resourcesPath, 'wallpaper-scene.html'), 'utf8'),
        fs.promises.readFile(path.join(resourcesPath, 'wallpaper-scene.js'), 'utf8')
    ]);
    return { template, runtime: patchWallpaperSceneRuntime(runtime), sceneScript };
}

/**
 * 生成场景页内容，并把三个输入的 sha256 一起返回，调用方据此判断缓存是否过期。
 */
export async function buildWallpaperScenePage(
    extensionPath: string
): Promise<{ html: string; stamp: string }> {
    const inputs = await loadWallpaperSceneInputs(extensionPath);
    const stamp = crypto.createHash('sha256')
        .update(inputs.template).update('\0')
        .update(inputs.runtime).update('\0')
        .update(inputs.sceneScript)
        .digest('hex');
    return { html: buildWallpaperSceneHtml(inputs.template, inputs.runtime, inputs.sceneScript), stamp };
}

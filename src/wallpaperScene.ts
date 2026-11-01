import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const WEBWALLGL_PLACEHOLDER = '__WALLPAPER_STUDIO_WEBWALLGL_BASE64__';
const SCENE_PLACEHOLDER = '__WALLPAPER_STUDIO_SCENE_BASE64__';

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
    return { template, runtime, sceneScript };
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

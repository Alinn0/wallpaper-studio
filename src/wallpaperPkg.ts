import * as fs from 'fs';
import * as path from 'path';

const PKG_HEADER_SIZE = 12;
// 与渲染器 parsePkg（webwallgl.mjs）的校验区间保持一致。
const PKG_MAGIC_MIN_LENGTH = 4;
const PKG_MAGIC_MAX_LENGTH = 16;
// 只要求 PKGV + 数字：容器布局自 PKGV0001 起未变，渲染器也不按版本分支，
// 因此不再限制具体版本号（PKGV0001–PKGV0024 乃至更新的编号都放行）。
const SCENE_PKG_MAGIC = /^PKGV\d+$/;

function readMagicLength(buffer: Uint8Array): number {
    return buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
}

export function isWallpaperPkgPath(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pkg';
}

export function isWallpaperMpkgPath(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.mpkg';
}

export function parseWallpaperPkgHeader(header: Uint8Array): string {
    if (header.length < PKG_HEADER_SIZE) {
        throw new Error('Wallpaper Engine .pkg 文件头不完整。');
    }

    const magicLength = readMagicLength(header);
    if (
        magicLength < PKG_MAGIC_MIN_LENGTH ||
        magicLength > PKG_MAGIC_MAX_LENGTH
    ) {
        throw new Error(
            `Wallpaper Engine .pkg 文件头异常（魔数长度 ${magicLength}），可能不是场景包或文件已损坏。`
        );
    }
    if (header.length < 4 + magicLength) {
        throw new Error('Wallpaper Engine .pkg 文件头不完整。');
    }

    const magic = String.fromCharCode(...header.subarray(4, 4 + magicLength));

    if (magic.startsWith('PKGM')) {
        throw new Error('Wallpaper Engine .mpkg（PKGM）暂不支持，请改用 .pkg 场景包。');
    }
    if (!SCENE_PKG_MAGIC.test(magic)) {
        throw new Error(
            `不是 Wallpaper Engine 场景包（魔数 ${magic.trim() || '空'}），请选择 .pkg 场景包。`
        );
    }
    return magic;
}

export async function validateWallpaperPkgFile(filePath: string): Promise<string> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const lengthBuffer = Buffer.alloc(4);
        const { bytesRead: lengthBytes } = await handle.read(lengthBuffer, 0, 4, 0);
        if (lengthBytes < 4) {
            throw new Error('Wallpaper Engine .pkg 文件头不完整。');
        }

        const magicLength = readMagicLength(lengthBuffer);
        const probeSize = magicLength >= PKG_MAGIC_MIN_LENGTH && magicLength <= PKG_MAGIC_MAX_LENGTH
            ? Math.max(4 + magicLength, PKG_HEADER_SIZE)
            : PKG_HEADER_SIZE;

        const header = Buffer.alloc(probeSize);
        const { bytesRead } = await handle.read(header, 0, probeSize, 0);
        return parseWallpaperPkgHeader(header.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
}

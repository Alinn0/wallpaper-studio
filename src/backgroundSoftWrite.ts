import * as fs from 'fs';
import * as path from 'path';
import { CUSTOM_CSS_FILE_PATH, WORKBENCH_DIR, getActiveWindowCssFile } from './FileDom';

/**
 * 背景「软写入」保活。
 *
 * 问题：真正的壁纸内容在 workbench 的 CSS 资源里，而**每个窗口会话**都会写一份
 * `css-wallpaper-studio.<session>.css`。session 每次启动都会变，所以：
 *   1. 下次打开 VS Code 时，注入端默认读的是共享的 `css-wallpaper-studio.css`，
 *      那份可能还是很久以前的旧图（甚至不存在）—— 表现为"要等一下才有背景"；
 *   2. 旧的会话文件没人回收，越堆越多。
 *
 * 这里做两件事，每 `INTERVAL_MS` 毫秒一次：
 *   - **软写入**：把当前窗口的 CSS 内容和共享文件同步一次，
 *     保证下次启动立刻就能读到当前壁纸（不去碰 21MB 的 workbench bundle）；
 *   - **清理**：删掉过期的会话级 CSS 文件，避免目录无限增长。
 *
 * 只读写几 KB 的 CSS，不重打补丁、不复制资源，开销可以忽略。
 */

/** 软写入间隔。太短会频繁 IO，太长则"下次打开是旧图"的窗口变大。 */
const INTERVAL_MS = 5000;
/**
 * 会话级 CSS 多久没被写过就算过期。
 *
 * 不能见到就删：其它还开着的 VS Code 窗口每秒都在读自己的那份，
 * 删掉虽然不会白屏（DOM 里的样式还在），但会在它们的控制台刷 fetch 失败。
 * 每个活跃窗口的软写入会把自己的文件 mtime 刷新，所以 60 秒足够区分
 * "还活着"和"上次启动留下的"。
 */
const STALE_AFTER_MS = 60_000;
/** `css-wallpaper-studio.<token>.css`（<token> 是会话 hash；共享文件不带后缀）。 */
const SESSION_CSS_RE = /^css-wallpaper-studio\.[^.]+\.css$/i;

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** 启动保活。重复调用是幂等的。 */
export function startBackgroundSoftWrite(): void {
    if (timer) { return; }
    timer = setInterval(() => { void softWriteOnce(); }, INTERVAL_MS);
    // 不要因为这个定时器阻止进程退出。
    (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopBackgroundSoftWrite(): void {
    if (!timer) { return; }
    clearInterval(timer);
    timer = undefined;
}

/**
 * 单次软写入 + 清理（导出以便单元测试直接调用，不必等定时器）。
 *
 * 一次只跑一个：上一轮还没写完就跳过这一轮，避免 IO 排队。
 */
export async function softWriteOnce(): Promise<void> {
    if (running) { return; }
    running = true;
    try {
        await syncSharedCss();
        await pruneStaleSessionCss();
    } catch (error) {
        console.warn('[WallpaperStudio] Soft write skipped:', error);
    } finally {
        running = false;
    }
}

/**
 * 把当前窗口的 CSS 同步到共享文件。
 *
 * 只有当前窗口已经有内容时才写：如果用户关掉了背景（CSS 为空），
 * 共享文件也该跟着空，下一次启动才是"无背景"而不是旧图。
 */
async function syncSharedCss(): Promise<void> {
    const active = getActiveWindowCssFile();
    if (path.normalize(active.filePath) === path.normalize(CUSTOM_CSS_FILE_PATH)) {
        // 共用模式：当前文件本身就是共享文件，落一次 mtime 即可。
        if (!fs.existsSync(active.filePath)) { return; }
        const now = new Date();
        try { fs.utimesSync(active.filePath, now, now); } catch { /* 忽略 */ }
        return;
    }

    let content: string;
    try {
        content = await fs.promises.readFile(active.filePath, 'utf8');
    } catch {
        // 当前窗口还没写过 CSS（没设置背景）——不要拿空内容覆盖共享文件。
        return;
    }

    let existing = '';
    try {
        existing = await fs.promises.readFile(CUSTOM_CSS_FILE_PATH, 'utf8');
    } catch {
        existing = '';
    }

    if (existing === content) {
        // 内容一致：只刷新 mtime，让「最近使用」的判定准确。
        const now = new Date();
        try { fs.utimesSync(CUSTOM_CSS_FILE_PATH, now, now); } catch { /* 忽略 */ }
        return;
    }

    try {
        // 先写临时文件再替换：注入端随时可能 fetch 这个路径，
        // 直接覆盖有概率读到半截内容（样式表被截断会闪一下）。
        const tempPath = `${CUSTOM_CSS_FILE_PATH}.tmp`;
        await fs.promises.writeFile(tempPath, content, 'utf8');
        await fs.promises.rename(tempPath, CUSTOM_CSS_FILE_PATH);
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to mirror CSS to shared file:', error);
    }
}

/** 删除过期的会话级 CSS 文件（保留当前窗口那一份）。 */
async function pruneStaleSessionCss(): Promise<void> {
    let names: string[];
    try {
        names = await fs.promises.readdir(WORKBENCH_DIR);
    } catch {
        return;
    }

    const active = getActiveWindowCssFile();
    const activeName = path.basename(active.filePath);
    const now = Date.now();

    for (const name of names) {
        // 顺带收掉写共享文件时可能残留的临时文件（进程被强杀时会留下）。
        const isTemp = name === `${path.basename(CUSTOM_CSS_FILE_PATH)}.tmp`;
        if (!isTemp && (!SESSION_CSS_RE.test(name) || name === activeName)) { continue; }
        const filePath = path.join(WORKBENCH_DIR, name);
        try {
            const stat = await fs.promises.stat(filePath);
            if (now - stat.mtimeMs < STALE_AFTER_MS) { continue; }
            await fs.promises.rm(filePath, { force: true });
        } catch {
            // 被占用 / 无权限：留给下一轮。
        }
    }
}

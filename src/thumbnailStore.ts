import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { atomicWriteTextSync } from './atomicWrite';

/**
 * 缩略图持久化存储（扩展侧）。
 *
 * 之前缩略图只存在 webview 的 localStorage 里。VS Code 重建面板（重启、重新加载窗口）
 * 后这份存储不保证还在，于是场景包又要重新用 WebWallGL 渲染一遍首帧、视频又要重新
 * 解码抓帧 —— 表现就是"每次打开都卡一下"。
 *
 * 这里把缩略图落到 `globalStorage/thumbnails/`：
 *   - 每张图一个文件（键的 md5 命名），避免每次读写整个大 JSON；
 *   - 索引记录访问时间，超过上限按 LRU 淘汰；
 *   - 总容量与条数都有上限，防止无限增长。
 */

const DIR_NAME = 'thumbnails';
const FILE_NAME_RE = /^[a-f0-9]{32}\.b64$/;
/** 条目数量上限。缩小尺寸后单张约 10–20 KB，可以多存一些。 */
const MAX_ENTRIES = 300;
/** 总容量上限（字符数）。 */
const MAX_TOTAL_CHARS = 24_000_000;
/**
 * 启动时一次性推给面板的总字符上限。
 *
 * 面板需要全部可用缩略图才能"打开即显示"，所以这个值必须容得下整份缓存。
 * 单张缩小到 ~15 KB 后，300 条约 4.5 MB，留足余量。
 */
const MAX_HYDRATE_CHARS = 12_000_000;
/**
 * 缩略图内容版本。
 *
 * v1 保存的是原始分辨率帧（4K 视频 → 单张 1 MB），总量能到几十 MB，
 * 超出传输上限的条目根本送不到面板。检测到旧版本直接清空重建。
 */
const STORE_VERSION = 2;
const VERSION_FILE = 'version';

interface IndexEntry {
    /** 键的 md5，对应磁盘上的 <hash>.b64 文件。 */
    hash: string;
    usedAt: number;
    chars: number;
}

type ThumbnailIndex = Record<string, IndexEntry>;

export class ThumbnailStore {
    private readonly dir: string;
    private readonly indexPath: string;
    private index: ThumbnailIndex | null = null;
    private generation = 0;

    constructor(storageRoot: string) {
        this.dir = path.join(storageRoot, DIR_NAME);
        this.indexPath = path.join(this.dir, 'index.json');
    }

    private hashOf(key: string): string {
        return crypto.createHash('md5').update(key).digest('hex');
    }

    private loadIndex(): ThumbnailIndex {
        if (this.index) { return this.index; }
        this.ensureVersion();
        try {
            const raw = fs.readFileSync(this.indexPath, 'utf8');
            const parsed = JSON.parse(raw);
            this.index = parsed && typeof parsed === 'object' ? parsed as ThumbnailIndex : {};
        } catch {
            this.index = {};
        }
        return this.index;
    }

    /**
     * 版本不匹配时清空整个缓存目录。
     *
     * 旧版本存的是原分辨率帧（单张可达 1 MB），总量会远超面板一次能接收的上限，
     * 结果就是"明明缓存了却还是要重新加载"。清空重建比逐条判断更简单可靠。
     */
    private ensureVersion(): void {
        const versionPath = path.join(this.dir, VERSION_FILE);
        let current = '';
        try { current = fs.readFileSync(versionPath, 'utf8').trim(); } catch { /* 首次运行 */ }
        if (current === String(STORE_VERSION)) { return; }
        try {
            if (fs.existsSync(this.dir)) {
                for (const name of fs.readdirSync(this.dir)) {
                    if (name === VERSION_FILE || name === 'index.json' || FILE_NAME_RE.test(name)) {
                        try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* 忽略 */ }
                    }
                }
            }
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(versionPath, String(STORE_VERSION), 'utf8');
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to reset thumbnail cache:', error);
        }
        this.index = {};
    }

    private saveIndex(): void {
        if (!this.index) { return; }
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            atomicWriteTextSync(this.indexPath, JSON.stringify(this.index));
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to write thumbnail index:', error);
        }
    }

    private fileOf(hash: string): string {
        return path.join(this.dir, `${hash}.b64`);
    }

    /** 预读索引（只读 index.json，不读图片数据）。 */
    warm(): void {
        this.loadIndex();
    }

    /** 读取一张缩略图（data URL）。未命中返回空串。 */
    get(key: string): string {
        const entry = this.loadIndex()[key];
        if (!entry) { return ''; }
        try {
            const b64 = fs.readFileSync(this.fileOf(entry.hash), 'utf8');
            if (!b64) { return ''; }
            entry.usedAt = Date.now();
            return b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
        } catch {
            return '';
        }
    }

    /** 写入一张缩略图；value 是 data URL。 */
    async set(key: string, value: string): Promise<void> {
        return this.setMany([[key, value]]);
    }

    /** One lock, one eviction pass and one index write for the whole batch. */
    async setMany(entries: Iterable<[string, string]>): Promise<void> {
        const batch = Array.from(entries).filter(([key, value]) => key && value && value.length <= 2_000_000);
        if (!batch.length) { return; }
        const generation = this.generation;
        let release: (() => Promise<void>) | undefined;
        try {
            await fs.promises.mkdir(this.dir, { recursive: true });
            release = await lockfile.lock(this.indexPath, {
                realpath: false,
                retries: { retries: 12, minTimeout: 25, maxTimeout: 250 },
                stale: 5000
            });
            if (generation !== this.generation) { return; }
            this.index = null;
            const index = this.loadIndex();
            for (const [key, value] of batch) {
                if (generation !== this.generation) { return; }
                const hash = this.hashOf(key);
                const payload = value.startsWith('data:') ? value : `data:image/jpeg;base64,${value}`;
                await fs.promises.writeFile(this.fileOf(hash), payload, 'utf8');
                if (generation !== this.generation) {
                    await fs.promises.unlink(this.fileOf(hash)).catch(() => undefined);
                    return;
                }
                index[key] = { hash, usedAt: Date.now(), chars: payload.length };
            }
            this.prune();
            this.saveIndex();
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to store thumbnail:', error);
        } finally {
            if (release) { await release(); }
        }
    }

    /** 按 LRU 与容量上限淘汰。 */
    private prune(): void {
        const index = this.loadIndex();
        const entries = Object.entries(index).sort((a, b) => b[1].usedAt - a[1].usedAt);
        let total = 0;
        let count = 0;
        const keep: ThumbnailIndex = {};
        for (const [key, entry] of entries) {
            const withinCount = count < MAX_ENTRIES;
            const withinSize = total + entry.chars <= MAX_TOTAL_CHARS;
            if (withinCount && withinSize) {
                keep[key] = entry;
                count++;
                total += entry.chars;
            } else {
                try { fs.rmSync(this.fileOf(entry.hash), { force: true }); } catch { /* 忽略 */ }
            }
        }
        this.index = keep;
    }

    /**
     * 启动时推给面板的初始数据（按最近使用排序，受总容量限制）。
     *
     * 用异步读：整份缓存可能有几 MB，同步 `readFileSync` 会把扩展宿主主线程
     * 卡住（连累所有扩展），异步反而更快完成整体启动。
     */
    async snapshot(): Promise<Record<string, string>> {
        const index = this.loadIndex();
        const entries = Object.entries(index).sort((a, b) => b[1].usedAt - a[1].usedAt);
        const result: Record<string, string> = {};
        let total = 0;
        for (const [key, entry] of entries) {
            if (total + entry.chars > MAX_HYDRATE_CHARS) { continue; }
            let raw: string;
            try {
                raw = await fs.promises.readFile(this.fileOf(entry.hash), 'utf8');
            } catch {
                continue;
            }
            if (!raw) { continue; }
            const value = raw.startsWith('data:') ? raw : `data:image/jpeg;base64,${raw}`;
            result[key] = value;
            total += value.length;
            entry.usedAt = Date.now();
        }
        return result;
    }

    clear(): void {
        this.generation++;
        this.index = {};
        try {
            if (!fs.existsSync(this.dir)) { return; }
            for (const name of fs.readdirSync(this.dir)) {
                if (name === 'index.json' || name === VERSION_FILE || FILE_NAME_RE.test(name)) {
                    try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* 忽略 */ }
                }
            }
        } catch (error) {
            console.warn('[WallpaperStudio] Failed to clear thumbnails:', error);
        }
    }
}

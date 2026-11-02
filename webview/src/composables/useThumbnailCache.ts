import { ref } from 'vue';

/**
 * 缩略图持久缓存（场景包首帧 / 视频首帧）。
 *
 * 列表里可能有几百个条目，每个都要查一次缓存，所以读操作必须走内存：
 * localStorage 只在启动时解析一次，写入则合并成一次延迟落盘。这样
 * 「第一次渲染后重新打开面板」直接命中缓存，不再重新渲染场景或解码视频。
 */

const CACHE_KEY = 'wallpaperStudio.thumbnailCache.v2';
/** 最多保留多少条缩略图（按最后访问时间 LRU）。 */
const MAX_ENTRIES = 200;
/** 序列化后的字符上限，兜住 localStorage 5MB 的配额。 */
const MAX_STORAGE_CHARS = 4_000_000;
/** 写盘节流，避免滚动/拖拽时连续序列化整个缓存。 */
const SAVE_DELAY_MS = 1500;

interface ThumbnailRecord {
    value: string;
    usedAt: number;
}

let memory: Record<string, ThumbnailRecord> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** 写回扩展侧的通道（由 App.vue 注入），用于跨 VS Code 重启保留缩略图。 */
let reporter: ((key: string, value: string) => void) | undefined;
/** Reactive signal for views that display a cached thumbnail. */
export const thumbnailRevision = ref(0);

export function setThumbnailReporter(fn: ((key: string, value: string) => void) | undefined): void {
    reporter = fn;
}

/**
 * 用扩展侧持久化的缩略图填充内存缓存（面板重新打开时不再重新渲染首帧）。
 *
 * 两个要点：
 *  1. **不触发落盘** —— 这批数据本来就在扩展侧持久化着，再序列化几 MB 写进
 *     localStorage 只会让打开面板卡住；localStorage 里已有的值继续保留即可。
 *  2. `usedAt` 用递增时间戳，而不是 0 —— 否则下一次 LRU 裁剪会把这批刚恢复的
 *     缓存当成"最久未用"全部淘汰，用户就又得重新渲染一遍。
 */
export function hydrateThumbnails(data: Record<string, string> | undefined): void {
    if (!data) { return; }
    const cache = load();
    const base = Date.now();
    let index = 0;
    for (const [key, value] of Object.entries(data)) {
        if (!key || !value) { continue; }
        if (cache[key]?.value) { continue; }
        cache[key] = { value, usedAt: base + (index += 1) };
    }
    thumbnailRevision.value++;
}

function load(): Record<string, ThumbnailRecord> {
    if (memory) { return memory; }
    let next: Record<string, ThumbnailRecord> = {};
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object') {
            next = Object.fromEntries(Object.entries(parsed).filter(([, record]) => {
                return !!record
                    && typeof record === 'object'
                    && typeof (record as ThumbnailRecord).value === 'string'
                    && typeof (record as ThumbnailRecord).usedAt === 'number';
            })) as Record<string, ThumbnailRecord>;
        }
    } catch {
        next = {};
    }
    memory = next;
    return next;
}

function scheduleSave(): void {
    if (saveTimer !== undefined) { return; }
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        const entries = Object.entries(load())
            .sort((a, b) => b[1].usedAt - a[1].usedAt)
            .slice(0, MAX_ENTRIES);
        let serialized = JSON.stringify(Object.fromEntries(entries));
        while (serialized.length > MAX_STORAGE_CHARS && entries.length > 1) {
            entries.pop();
            serialized = JSON.stringify(Object.fromEntries(entries));
        }
        memory = Object.fromEntries(entries);
        try {
            localStorage.setItem(CACHE_KEY, serialized);
        } catch {
            // 配额写满时保留内存缓存即可，不能影响正在显示的画面。
        }
    }, SAVE_DELAY_MS);
}

export function getThumbnail(key: string): string {
    if (!key) { return ''; }
    const record = load()[key];
    if (!record?.value) { return ''; }
    // 命中时只更新内存中的时间戳；延迟落盘避免连续读取时反复序列化整个缓存。
    record.usedAt = Date.now();
    scheduleSave();
    return record.value;
}

export function setThumbnail(key: string, value: string): void {
    if (!key || !value) { return; }
    load()[key] = { value, usedAt: Date.now() };
    thumbnailRevision.value++;
    scheduleSave();
    try { reporter?.(key, value); } catch { /* 通道未就绪时忽略 */ }
}

export function clearThumbnailCache(): void {
    if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
    }
    memory = {};
    thumbnailRevision.value++;
    try {
        localStorage.removeItem(CACHE_KEY);
    } catch {
        // 存储不可用时无需清理。
    }
}

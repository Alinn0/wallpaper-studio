import { ref } from 'vue';

/**
 * 缩略图持久缓存（场景包首帧 / 视频首帧）。
 *
 * 列表里可能有几百个条目，每个都要查一次缓存，所以读操作必须走内存：
 * 持久化由扩展侧 ThumbnailStore 负责，Webview 只保留当前面板生命周期内的内存副本。
 */

/** 序列化后的字符上限，兜住 localStorage 5MB 的配额。 */

interface ThumbnailRecord {
    value: string;
    usedAt: number;
}

let memory: Record<string, ThumbnailRecord> | null = null;
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
    if (!memory) { memory = {}; }
    return memory;
}

export function getThumbnail(key: string): string {
    if (!key) { return ''; }
    const record = load()[key];
    if (!record?.value) { return ''; }
    // 命中时只更新内存中的时间戳；延迟落盘避免连续读取时反复序列化整个缓存。
    record.usedAt = Date.now();
    return record.value;
}

export function setThumbnail(key: string, value: string): void {
    if (!key || !value) { return; }
    load()[key] = { value, usedAt: Date.now() };
    thumbnailRevision.value++;
    try { reporter?.(key, value); } catch { /* 通道未就绪时忽略 */ }
}

export function clearThumbnailCache(): void {
    memory = {};
    thumbnailRevision.value++;
}

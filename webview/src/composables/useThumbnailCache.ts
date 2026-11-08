import { ref } from 'vue';

/**
 * 缩略图持久缓存（场景包首帧 / 视频首帧）。
 *
 * 列表里可能有几百个条目，每个都要查一次缓存，所以读操作必须走内存：
 * 持久化由扩展侧 ThumbnailStore 负责，Webview 只保留当前面板生命周期内的内存副本。
 */

interface ThumbnailRecord {
    value: string;
    usedAt: number;
}

let memory: Record<string, ThumbnailRecord> | null = null;
let lastUsedAt = 0;
function nextUsedAt(): number {
    lastUsedAt = Math.max(Date.now(), lastUsedAt + 1);
    return lastUsedAt;
}
const MAX_MEMORY_ENTRIES = 300;
const MAX_MEMORY_CHARS = 12_000_000;
let currentPreviewKeys = new Set<string>();

/** The current home image stays inside the same budget while gallery entries rotate. */
export function setCurrentPreviewKeys(keys: string[]): void { currentPreviewKeys = new Set(keys.slice(0, 2)); }

function pruneMemory() {
    const cache = load();
    let count = 0;
    let chars = 0;
    for (const [key, entry] of Object.entries(cache).sort((a, b) =>
        Number(currentPreviewKeys.has(b[0])) - Number(currentPreviewKeys.has(a[0])) || b[1].usedAt - a[1].usedAt)) {
        if (++count > MAX_MEMORY_ENTRIES || chars + entry.value.length > MAX_MEMORY_CHARS) {
            delete cache[key];
        } else { chars += entry.value.length; }
    }
}
/** 写回扩展侧的通道（由 App.vue 注入），用于跨 VS Code 重启保留缩略图。 */
let reporter: ((key: string, value: string) => void) | undefined;
let reader: ((keys: string[]) => Promise<Record<string, string>>) | undefined;
const missing = new Set<string>();
const pending = new Map<string, Promise<void>>();
const waiting = new Map<string, () => void>();
let lookupScheduled = false;
let cacheGeneration = 0;
export const thumbnailCacheStats = { diskRequests: 0, diskHits: 0, diskMisses: 0, generated: 0, sceneRenders: 0 };
/** Reactive signal for views that display a cached thumbnail. */
export const thumbnailRevision = ref(0);

export function setThumbnailReporter(fn: ((key: string, value: string) => void) | undefined): void {
    reporter = fn;
}

export function setThumbnailReader(fn: (keys: string[]) => Promise<Record<string, string>>): void { reader = fn; }

/** A cache miss must be confirmed on disk before loading the original media. */
export function isThumbnailReady(key: string): boolean {
    void thumbnailRevision.value;
    return !!getThumbnail(key) || missing.has(key);
}

export async function ensureThumbnails(keys: string[]): Promise<void> {
    const requests: Promise<void>[] = [];
    for (const key of new Set(keys.filter(Boolean))) {
        if (getThumbnail(key) || missing.has(key)) { continue; }
        let request = pending.get(key);
        if (!request) {
            request = new Promise<void>(resolve => { waiting.set(key, resolve); });
            pending.set(key, request);
        }
        requests.push(request);
    }
    if (waiting.size && !lookupScheduled) {
        lookupScheduled = true;
        void Promise.resolve().then(async () => {
            while (waiting.size) {
                const batch = [...waiting.entries()].slice(0, 64);
                const generation = cacheGeneration;
                batch.forEach(([key]) => waiting.delete(key));
                let data: Record<string, string> = {};
                try { thumbnailCacheStats.diskRequests++; data = await reader?.(batch.map(([key]) => key)) || {}; }
                catch (error) { console.warn('[WallpaperStudio] Thumbnail lookup failed:', error); }
                if (generation === cacheGeneration) { hydrateThumbnails(data); }
                for (const [key, resolve] of batch) {
                    if (generation !== cacheGeneration) { pending.delete(key); resolve(); continue; }
                    if (getThumbnail(key)) { thumbnailCacheStats.diskHits++; }
                    else { missing.add(key); thumbnailCacheStats.diskMisses++; }
                    pending.delete(key); resolve();
                }
                while (missing.size > 600) { missing.delete(missing.values().next().value!); }
                thumbnailRevision.value++;
            }
            lookupScheduled = false;
        });
    }
    await Promise.all(requests);
}

/**
 * 用扩展侧持久化的缩略图填充内存缓存（面板重新打开时不再重新渲染首帧）。
 *
 * 两个要点：
 *  1. **不触发落盘** —— 这批数据已由扩展持久化，只填充有界内存，不重复上报。
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
        cache[key] = { value, usedAt: base - (index += 1) };
    }
    pruneMemory();
    thumbnailRevision.value++;
}

function load(): Record<string, ThumbnailRecord> {
    if (!memory) { memory = {}; }
    return memory;
}

export function getThumbnail(key: string): string {
    void thumbnailRevision.value;
    if (!key) { return ''; }
    const record = load()[key];
    if (!record?.value) { return ''; }
    // 命中时只更新内存中的时间戳；延迟落盘避免连续读取时反复序列化整个缓存。
    record.usedAt = nextUsedAt();
    return record.value;
}

export function setThumbnail(key: string, value: string): void {
    if (!key || !value) { return; }
    if (load()[key]?.value === value) { load()[key].usedAt = nextUsedAt(); return; }
    load()[key] = { value, usedAt: nextUsedAt() };
    missing.delete(key);
    thumbnailCacheStats.generated++;
    pruneMemory();
    thumbnailRevision.value++;
    try { reporter?.(key, value); } catch { /* 通道未就绪时忽略 */ }
}

export function removeThumbnail(key: string): void {
    delete load()[key];
    thumbnailRevision.value++;
}

/** Views retain keys, never an additional unbounded copy of JPEG strings. */
export function thumbnailView(keyOf: (key: string) => string): Record<string, string> {
    return new Proxy({} as Record<string, string>, {
        get: (_target, key) => typeof key === 'string' ? getThumbnail(keyOf(key)) : undefined,
        set: (_target, key, value) => { if (typeof key === 'string') { setThumbnail(keyOf(key), value); } return true; },
        deleteProperty: (_target, key) => { if (typeof key === 'string') { removeThumbnail(keyOf(key)); } return true; }
    });
}

export function clearThumbnailCache(): void {
    cacheGeneration++;
    memory = {};
    missing.clear();
    thumbnailRevision.value++;
}

import { reactive } from 'vue';
import { ensureThumbnails, getThumbnail, setThumbnail } from './useThumbnailCache';

/** Shared artwork cache for list and home, separate from rendered media frames. */
export const projectCoverKey = (source: string): string => `project-cover:${source}`;
const animatedCovers = reactive<Record<string, string>>({});
export const isAnimatedCover = (source: string): boolean => /\.gif(?:[?#]|$)/i.test(source);
export function getProjectCover(source: string): string {
    return isAnimatedCover(source) ? animatedCovers[source] || '' : getThumbnail(projectCoverKey(source));
}
const queue: Array<() => void> = [];
let active = 0;
function pump(): void {
    while (active < 3 && queue.length) { queue.shift()!(); }
}

/** Only visible rows request artwork. Cancellation also removes waiting jobs. */
export function requestProjectCover(source: string, signal: AbortSignal): Promise<string> {
    return new Promise(resolve => {
        const cancelQueued = () => {
            const index = queue.indexOf(run);
            if (index >= 0) { queue.splice(index, 1); resolve(''); }
        };
        const run = () => {
            signal.removeEventListener('abort', cancelQueued);
            if (signal.aborted) { resolve(''); return; }
            active++;
            void loadProjectCover(source, signal).catch(() => '').then(resolve).finally(() => { active--; pump(); });
        };
        if (signal.aborted) { resolve(''); return; }
        signal.addEventListener('abort', cancelQueued, { once: true });
        queue.push(run);
        pump();
    });
}

async function loadProjectCover(source: string, signal: AbortSignal): Promise<string> {
    const key = projectCoverKey(source);
    const animated = isAnimatedCover(source);
    // Old GIF-to-JPEG cache entries may contain a blank first frame. Never reuse them.
    if (!animated) { await ensureThumbnails([key]); }
    if (signal.aborted) { return ''; }
    const cached = getProjectCover(source);
    if (cached) { return cached; }
    return new Promise(resolve => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        let finished = false;
        const finish = (value = '') => {
            if (finished) { return; }
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
            image.onload = null;
            image.onerror = null;
            image.removeAttribute('src');
            resolve(value);
        };
        const cancel = () => finish();
        const timer = setTimeout(cancel, 8000);
        signal.addEventListener('abort', cancel, { once: true });
        image.onerror = () => finish();
        image.onload = () => {
            if (signal.aborted || !image.naturalWidth || !image.naturalHeight) { finish(); return; }
            if (animated) {
                animatedCovers[source] = source;
                const keys = Object.keys(animatedCovers);
                if (keys.length > 300) { delete animatedCovers[keys[0]]; }
                finish(source);
                return;
            }
            try {
                const scale = Math.min(1, 320 / image.naturalWidth, 320 / image.naturalHeight);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const context = canvas.getContext('2d');
                if (!context) { finish(); return; }
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const value = canvas.toDataURL('image/jpeg', 0.75);
                setThumbnail(key, value);
                finish(value);
            } catch { finish(); }
        };
        image.src = source;
    });
}

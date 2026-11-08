import * as fs from 'fs';
import { pipeline } from 'stream';
import * as lockfile from 'proper-lockfile';
import { BackgroundApplyCancelledError } from './backgroundError';

export function checkCancellation(signal?: AbortSignal): void {
    if (signal?.aborted) { throw new BackgroundApplyCancelledError(); }
}

export function cancellationDelay(ms: number, signal?: AbortSignal): Promise<void> {
    checkCancellation(signal);
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new BackgroundApplyCancelledError()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

/** A cancelled waiter never acquires a late lock. */
export async function acquireFileLock(file: string, signal?: AbortSignal, timeout = 30000): Promise<() => Promise<void>> {
    const deadline = Date.now() + timeout;
    for (;;) {
        checkCancellation(signal);
        try {
            const release = await lockfile.lock(file, { realpath: false, stale: 30000, update: 5000, retries: 0 });
            if (signal?.aborted) { await release(); checkCancellation(signal); }
            return release;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) { throw error; }
            await cancellationDelay(50, signal);
        }
    }
}

export function copyFileCancellable(source: string, target: string, signal?: AbortSignal): Promise<void> {
    checkCancellation(signal);
    return new Promise((resolve, reject) => {
        const input = fs.createReadStream(source);
        const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
        const abort = () => { input.destroy(new BackgroundApplyCancelledError()); output.destroy(new BackgroundApplyCancelledError()); };
        signal?.addEventListener('abort', abort, { once: true });
        pipeline(input, output, error => {
            signal?.removeEventListener('abort', abort);
            if (error) { reject(error); } else { resolve(); }
        });
    });
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CACHE_ROOT } from './cachePaths';
import { acquireFileLock, checkCancellation } from './cancellation';
import { atomicWriteTextSync } from './atomicWrite';

interface Pending { id: string; path: string; at: number; }
const file = path.join(CACHE_ROOT, 'pending-loads.json');
const local = new Map<string, { scope: string; controller: AbortController }>();
function read(): Record<string, Pending> {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
            const entry = value as Pending;
            return entry && typeof entry.id === 'string' && typeof entry.path === 'string' && Date.now() - entry.at < 180000;
        })) as Record<string, Pending>;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        return {};
    }
}
export function pendingDisplayRequest(scope: string): Pending | undefined { return read()[scope]; }
export interface DisplayRequest { id: string; signal: AbortSignal; isCurrent(): boolean; finish(): Promise<void>; }

/** Shared request fencing prevents another host's appearance update or old load from committing. */
export async function claimDisplayRequest(scope: string, source: string, signal: AbortSignal, automatic = false): Promise<DisplayRequest | undefined> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { controller.abort(); }
    const id = crypto.randomBytes(16).toString('hex');
    const finish = async () => {
        controller.abort();
        signal.removeEventListener('abort', abort);
        local.delete(id);
        const release = await acquireFileLock(file);
        try {
            const latest = read();
            if (latest[scope]?.id === id) { delete latest[scope]; atomicWriteTextSync(file, JSON.stringify(latest)); }
        } finally { await release(); }
    };
    await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
    let claimed = false;
    try {
        const release = await acquireFileLock(file, controller.signal);
        try {
            const latest = read();
            if (automatic && latest[scope]) { return undefined; }
            checkCancellation(controller.signal);
            latest[scope] = { id, path: source, at: Date.now() };
            atomicWriteTextSync(file, JSON.stringify(Object.fromEntries(Object.entries(latest).sort((a, b) => b[1].at - a[1].at).slice(0, 40))));
            claimed = true;
            for (const request of local.values()) {
                if (request.scope === scope) { request.controller.abort(); }
            }
            local.set(id, { scope, controller });
        } finally { await release(); }
        checkCancellation(controller.signal);
        return { id, signal: controller.signal, isCurrent: () => !controller.signal.aborted && pendingDisplayRequest(scope)?.id === id, finish };
    } catch (error) {
        if (claimed) { await finish(); }
        throw error;
    } finally { if (!claimed) { signal.removeEventListener('abort', abort); } }
}

export function startDisplayRequestSync(onChange: () => void = () => {}): { dispose(): void } {
    const listener = () => {
        try {
            const latest = read();
            for (const [id, request] of local) {
                if (latest[request.scope]?.id !== id) { request.controller.abort(); }
            }
            onChange();
        } catch (error) { console.warn('[WallpaperStudio] Pending request refresh skipped:', error); }
    };
    fs.watchFile(file, { interval: 250, persistent: false }, listener);
    return { dispose: () => { fs.unwatchFile(file, listener); local.forEach(request => request.controller.abort()); } };
}

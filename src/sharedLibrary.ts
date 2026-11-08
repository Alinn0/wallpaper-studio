import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { EventEmitter, ExtensionContext, Memento } from 'vscode';
import { atomicWriteTextSync } from './atomicWrite';
import { setLibraryError } from './libraryHealth';
export { getLibraryError, onDidChangeLibraryStatus } from './libraryHealth';

const FILE = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR || path.join(os.homedir(), '.wallpaper-studio'), 'library.json');
export const LIBRARY_KEYS = [
    'wallpaperStudioSourceMode', 'wallpaperStudioLocalFiles',
    'wallpaperStudioWallpaperConfig', 'wallpaperStudioWallpaperUser',
    'wallpaperStudioWallpaperRemoved', 'wallpaperStudioFolderRemoved', 'wallpaperStudioWallpaperProperties'
];
const keys = new Set(LIBRARY_KEYS);
type Values = Record<string, unknown>;
interface Library { version: number; values: Values; }
const changes = new EventEmitter<string[]>();
export const onDidChangeLibrary = changes.event;
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
let diskSignature = '';
let diskCache: Library | undefined;
function read(): Library | undefined {
    if (!fs.existsSync(FILE)) { return undefined; }
    const stat = fs.statSync(FILE);
    const signature = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
    if (signature === diskSignature && diskCache) { return diskCache; }
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data.version !== 1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
        throw new Error('Invalid shared wallpaper library');
    }
    diskSignature = signature;
    diskCache = data;
    return data;
}
async function locked<T>(fn: () => T): Promise<T> {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const release = await lockfile.lock(FILE, { realpath: false, retries: { retries: 12, minTimeout: 25, maxTimeout: 250 }, stale: 5000 });
    try { return fn(); } finally { await release(); }
}

/** Route only library keys to shared storage; other VS Code state retains its original scope. */
export async function createSharedLibraryContext(context: ExtensionContext): Promise<ExtensionContext> {
    const original = context.globalState;
    let snapshot: Library;
    try { snapshot = await locked(() => {
        const existing = read();
        if (existing) { return existing; }
        const values: Values = {};
        // One initial migration. Later Profiles cannot resurrect removed files or overwrite shared edits.
        for (const key of LIBRARY_KEYS) {
            const value = original.get<unknown>(key);
            if (value !== undefined) { values[key] = copy(value); }
        }
        const initial = { version: 1, values };
        atomicWriteTextSync(FILE, JSON.stringify(initial, null, 2));
        return initial;
    }); setLibraryError(undefined); }
    catch (error) { snapshot = { version: 1, values: {} }; setLibraryError(error); }
    const accept = (next: Library) => {
        setLibraryError(undefined);
        const changed = LIBRARY_KEYS.filter(key => JSON.stringify(snapshot.values[key]) !== JSON.stringify(next.values[key]));
        snapshot = next;
        if (changed.length) { changes.fire(changed); }
    };
    const mutate = async <T>(key: string, fallback: T, change: (value: T) => T): Promise<void> => {
        if (!keys.has(key)) { await original.update(key, change(original.get<T>(key, fallback))); return; }
        const next = await locked(() => {
            const latest = copy(read());
            if (!latest) { throw new Error('Shared wallpaper library is missing; refusing to overwrite it'); }
            const value = change(copy((latest.values[key] === undefined ? fallback : latest.values[key]) as T));
            if (value === undefined) { delete latest.values[key]; } else { latest.values[key] = copy(value); }
            atomicWriteTextSync(FILE, JSON.stringify(latest, null, 2));
            return latest;
        });
        accept(next);
    };
    const shared = new Proxy({} as Memento, {
        get(_target, property) {
            const target = original;
            if (property === 'mutate') { return mutate; }
            if (property === 'getRecordEntry') {
                return (key: string, entry: string) => {
                    let current = snapshot;
                    try { current = read() || snapshot; } catch { /* Last valid snapshot. */ }
                    const record = current.values[key] as Record<string, unknown> | undefined;
                    return copy(record?.[entry]);
                };
            }
            if (property === 'get') {
                return <T>(key: string, fallback?: T): T | undefined => {
                    if (!keys.has(key)) { return target.get<T>(key, fallback as T); }
                    // Refresh reads immediately; watcher independently delivers UI notifications.
                    try { const latest = read(); if (latest) { return copy((latest.values[key] === undefined ? fallback : latest.values[key]) as T); } }
                    catch { /* Keep the last valid snapshot while an external edit is incomplete. */ }
                    return copy((snapshot.values[key] === undefined ? fallback : snapshot.values[key]) as T);
                };
            }
            if (property === 'update') { return (key: string, value: unknown) => mutate(key, undefined, () => value); }
            if (property === 'keys') { return () => Array.from(new Set([...target.keys(), ...Object.keys(snapshot.values)])); }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    }) as Memento & ExtensionContext['globalState'];
    const listener = () => {
        try { const latest = read(); if (latest) { accept(latest); } }
        catch (error) { setLibraryError(error); console.warn('[WallpaperStudio] Shared library reload skipped:', error); }
    };
    fs.watchFile(FILE, { interval: 500, persistent: false }, listener);
    context.subscriptions.push({ dispose: () => fs.unwatchFile(FILE, listener) });
    // VS Code freezes context.globalState. A proxy over context cannot replace
    // that value without violating Proxy invariants and aborting activation.
    return new Proxy({} as ExtensionContext, {
        get(_target, property) {
            if (property === 'globalState') { return shared; }
            const value = Reflect.get(context, property);
            return typeof value === 'function' ? value.bind(context) : value;
        }
    });
}

export async function resetSharedLibrary(): Promise<void> {
    await locked(() => {
        if (fs.existsSync(FILE)) {
            const backup = path.join(path.dirname(FILE), 'backups', 'library-reset-' + Date.now() + '-' + process.pid + '.json');
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            fs.copyFileSync(FILE, backup);
        }
        atomicWriteTextSync(FILE, JSON.stringify({ version: 1, values: {} }));
        diskSignature = '';
        diskCache = undefined;
    });
    setLibraryError(undefined);
    changes.fire(LIBRARY_KEYS.slice());
}

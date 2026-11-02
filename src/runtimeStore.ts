import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getContext } from './global';
import * as lockfile from 'proper-lockfile';

export const RUNTIME_FILE = path.join(os.homedir(), '.wallpaper-studio', 'runtime.json');

export interface RuntimeState {
    version: number;
    workspacePaths: Record<string, string>;
    workspaceImages: Record<string, string>;
    windowOpacity: Record<string, number>;
    workspaceOpacity: Record<string, number>;
    windowBlur: Record<string, number>;
    workspaceBlur: Record<string, number>;
}

const DEFAULT_RUNTIME: RuntimeState = {
    version: 1,
    workspacePaths: {},
    workspaceImages: {},
    windowOpacity: {},
    workspaceOpacity: {},
    windowBlur: {},
    workspaceBlur: {}
};

let cache: RuntimeState | null = null;
let migrationChecked = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) { return {}; }
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'string')
    ) as Record<string, string>;
}

function numberMap(value: unknown): Record<string, number> {
    if (!isRecord(value)) { return {}; }
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))
    ) as Record<string, number>;
}

function normalize(value: unknown): RuntimeState {
    const source = isRecord(value) ? value : {};
    return {
        version: 1,
        workspacePaths: stringMap(source.workspacePaths),
        workspaceImages: stringMap(source.workspaceImages),
        windowOpacity: numberMap(source.windowOpacity),
        workspaceOpacity: numberMap(source.workspaceOpacity),
        windowBlur: numberMap(source.windowBlur),
        workspaceBlur: numberMap(source.workspaceBlur)
    };
}

function readDisk(): RuntimeState | null {
    try {
        return normalize(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')));
    } catch {
        return null;
    }
}

function readLegacyState(): RuntimeState {
    const globalState = getContext().globalState;
    return normalize({
        workspaceImages: globalState.get<Record<string, string>>('wallpaperStudio.workspaceImages', {}),
        workspacePaths: globalState.get<Record<string, string>>('wallpaperStudio.workspacePaths', {}),
        windowOpacity: globalState.get<Record<string, number>>('wallpaperStudio.windowOpacity', {}),
        workspaceOpacity: globalState.get<Record<string, number>>('wallpaperStudio.workspaceOpacity', {}),
        windowBlur: globalState.get<Record<string, number>>('wallpaperStudio.windowBlur', {}),
        workspaceBlur: globalState.get<Record<string, number>>('wallpaperStudio.workspaceBlur', {})
    });
}

function persist(state: RuntimeState): boolean {
    try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        fs.writeFileSync(RUNTIME_FILE, JSON.stringify(state, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to persist runtime state:', error);
        return false;
    }
}

function ensureLoaded(): RuntimeState {
    if (cache) { return cache; }
    const disk = readDisk();
    if (disk) {
        cache = disk;
        migrationChecked = true;
        return cache;
    }
    cache = readLegacyState();
    migrationChecked = true;
    persist(cache);
    return cache;
}

/** Read the latest runtime state, reloading the file to support multiple windows. */
export function readRuntimeState(): RuntimeState {
    const disk = readDisk();
    if (disk) {
        cache = disk;
        migrationChecked = true;
    } else if (!migrationChecked) {
        ensureLoaded();
    }
    return normalize(cache || DEFAULT_RUNTIME);
}

/** Mutate and persist runtime state. Failed writes are not reflected in the cache. */
export async function updateRuntimeState(mutator: (state: RuntimeState) => void): Promise<boolean> {
    const next = readRuntimeState();
    mutator(next);
    try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        if (!fs.existsSync(RUNTIME_FILE)) {
            fs.writeFileSync(RUNTIME_FILE, JSON.stringify(DEFAULT_RUNTIME, null, 2), 'utf8');
        }
        const release = await lockfile.lock(RUNTIME_FILE, {
            retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
            stale: 5000
        });
        try {
            const latest = readDisk() || DEFAULT_RUNTIME;
            mutator(latest);
            if (!persist(latest)) { return false; }
            cache = latest;
            return true;
        } finally {
            await release();
        }
    } catch (error) {
        console.warn('[WallpaperStudio] Failed to lock runtime state:', error);
        return false;
    }
}

export async function clearRuntimeState(): Promise<boolean> {
    cache = normalize(DEFAULT_RUNTIME);
    return updateRuntimeState(state => {
        Object.assign(state, normalize(DEFAULT_RUNTIME));
    });
}

/** Remove records written by versions that used global/session-scoped images. */
export async function clearLegacyImageRecords(): Promise<void> {
    const state = getContext().globalState;
    for (const key of [
        'wallpaperStudio.globalImage',
        'wallpaperStudio.windowImages',
        'wallpaperStudio.workspaceImages'
    ]) {
        if (state.get<unknown>(key) !== undefined) {
            await state.update(key, undefined);
        }
    }

}

/** Remove workspace image entries that have no folder metadata in the new format. */
export async function pruneOrphanedWorkspaceRecords(): Promise<void> {
    await updateRuntimeState(runtime => {
        if (!Object.keys(runtime.workspacePaths).length) {
            return;
        }
        for (const key of Object.keys(runtime.workspaceImages)) {
            if (key !== 'no-workspace' && !Object.prototype.hasOwnProperty.call(runtime.workspacePaths, key)) {
                delete runtime.workspaceImages[key];
            }
        }
    });
}

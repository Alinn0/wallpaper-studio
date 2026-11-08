import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getContext } from './global';
import * as lockfile from 'proper-lockfile';
import { atomicWriteTextSync } from './atomicWrite';
import { createEvent } from './events';

export const RUNTIME_FILE = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR || path.join(os.homedir(), '.wallpaper-studio'), 'runtime.json');

export interface RuntimeState {
    version: number;
    workspacePaths: Record<string, string>;
    workspaceImages: Record<string, string>;
    workspacePreviousImages: Record<string, string>;
    workspacePinnedImages: Record<string, string>;
    workspaceStagedImages: Record<string, string>;
}

const DEFAULT_RUNTIME: RuntimeState = {
    version: 1,
    workspacePaths: {},
    workspaceImages: {},
    workspacePreviousImages: {},
    workspacePinnedImages: {},
    workspaceStagedImages: {},
};

let cache: RuntimeState | null = null;
let migrationChecked = false;
const runtimeChanges = createEvent<{ external: boolean }>();
export const onDidChangeRuntime = runtimeChanges.event;
let lastRuntimeText = '';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) { return {}; }
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => typeof item === 'string')
    ) as Record<string, string>;
}

function normalize(value: unknown): RuntimeState {
    const source = isRecord(value) ? value : {};
    return {
        version: 1,
        workspacePaths: stringMap(source.workspacePaths),
        workspaceImages: stringMap(source.workspaceImages),
        workspacePreviousImages: stringMap(source.workspacePreviousImages),
        workspacePinnedImages: stringMap(source.workspacePinnedImages),
        workspaceStagedImages: stringMap(source.workspaceStagedImages),
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
    });
}

function persist(state: RuntimeState): boolean {
    try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        atomicWriteTextSync(RUNTIME_FILE, JSON.stringify(state, null, 2));
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
    try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        const release = await lockfile.lock(RUNTIME_FILE, {
            realpath: false,
            retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
            stale: 5000
        });
        try {
            const disk = readDisk();
            if (!disk && fs.existsSync(RUNTIME_FILE)) { throw new Error('Runtime state is not valid JSON'); }
            const latest = disk || normalize(cache || readLegacyState());
            mutator(latest);
            if (!persist(latest)) { return false; }
            cache = latest;
            lastRuntimeText = JSON.stringify(latest);
            runtimeChanges.fire({ external: false });
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
    return updateRuntimeState(state => {
        Object.assign(state, normalize(DEFAULT_RUNTIME));
    });
}

export function startRuntimeSync(): { dispose(): void } {
    lastRuntimeText = JSON.stringify(readRuntimeState());
    const listener = () => {
        const disk = readDisk();
        if (!disk) { return; }
        const text = JSON.stringify(disk);
        if (text === lastRuntimeText) { return; }
        lastRuntimeText = text;
        cache = disk;
        runtimeChanges.fire({ external: true });
    };
    fs.watchFile(RUNTIME_FILE, { interval: 500, persistent: false }, listener);
    return { dispose: () => fs.unwatchFile(RUNTIME_FILE, listener) };
}

/** Remove records written by versions that used global/session-scoped images. */
export async function clearLegacyImageRecords(): Promise<void> {
    const state = getContext().globalState;
    for (const key of [
        'wallpaperStudioRecentImages',
        'wallpaperStudioDefaultModeWallpaper',
        'wallpaperStudioWallpaperEnabled',
        'wallpaperStudioOnlineFolder',
        'wallpaperStudioOnlineImageList',
        'wallpaperStudioSingleImageSource',
        'wallpaperStudio.windowOpacity',
        'wallpaperStudio.workspaceOpacity',
        'wallpaperStudio.windowBlur',
        'wallpaperStudio.workspaceBlur',
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
                delete runtime.workspacePreviousImages[key];
                delete runtime.workspacePinnedImages[key];
                delete runtime.workspaceStagedImages[key];
            }
        }
    });
}

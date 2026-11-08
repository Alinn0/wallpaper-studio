import * as fs from 'fs';
import * as path from 'path';
import { CACHE_ROOT } from './cachePaths';
import { atomicWriteTextSync } from './atomicWrite';
import { WallpaperEntry } from './wallpaperEngine';

const file = path.join(CACHE_ROOT, 'playlist-cache.json');
let generation = 0;

function stamp(target: string): string {
    try {
        const s = fs.statSync(target);
        return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch { return 'missing'; }
}

export function playlistSnapshotKey(config: string, user: string | undefined, removed: string[]): string {
    return JSON.stringify([path.resolve(config), stamp(config), user || '', [...removed].sort()]);
}

export function playlistDependencies(paths: string[]): Array<[string, string]> {
    const files = new Set<string>();
    for (const target of paths) {
        files.add(target);
        files.add(path.dirname(target));
        files.add(path.join(path.dirname(target), 'project.json'));
    }
    return [...files].map(target => [target, stamp(target)]);
}

function unchanged(dependencies: Array<[string, string]>): boolean {
    return dependencies.every(([target, signature]) => stamp(target) === signature);
}

/** Native paths only: webview URIs and current selection belong to the current host. */
export function readPlaylistSnapshot(key: string): WallpaperEntry[] | undefined {
    try {
        if (fs.statSync(file).size > 8_000_000) { return undefined; }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || data.key !== key || !Array.isArray(data.dependencies)
            || !Array.isArray(data.entries) || data.entries.length > 10000) { return undefined; }
        if (!data.entries.every((e: WallpaperEntry) => e && typeof e.path === 'string'
            && typeof e.title === 'string' && typeof e.description === 'string' && typeof e.preview === 'string'
            && typeof e.sceneSource === 'string' && typeof e.active === 'boolean' && Array.isArray(e.properties))) { return undefined; }
        return unchanged(data.dependencies) ? data.entries : undefined;
    } catch { return undefined; }
}

export function playlistSnapshotGeneration(): number { return generation; }

export function writePlaylistSnapshot(key: string, entries: WallpaperEntry[], dependencies: Array<[string, string]>, started: number): void {
    if (started !== generation || entries.length > 10000 || !unchanged(dependencies)) { return; }
    try {
        const content = JSON.stringify({ version: 1, key, entries, dependencies });
        if (content.length <= 8_000_000) { atomicWriteTextSync(file, content); }
    } catch (error) { console.warn('[WallpaperStudio] Playlist cache write skipped:', error); }
}

export function clearPlaylistSnapshot(): void {
    generation++;
    try { fs.unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
}

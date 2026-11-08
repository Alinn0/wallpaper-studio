import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { CACHE_ROOT } from './cachePaths';
import { atomicWriteTextSync } from './atomicWrite';
import { acquireFileLock } from './cancellation';

const rotationFile = path.join(CACHE_ROOT, 'rotation.json');
const presenceDir = path.join(CACHE_ROOT, 'sessions');
type Times = Record<string, number>;
function readTimes(): Times {
    try {
        const values = JSON.parse(fs.readFileSync(rotationFile, 'utf8'));
        return Object.fromEntries(Object.entries(values).filter(([, value]) => Number.isFinite(value))) as Times;
    } catch { return {}; }
}

export async function recordWallpaperChange(scope: string): Promise<void> {
    await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
    const release = await acquireFileLock(rotationFile);
    try {
        const times = readTimes();
        times[scope] = Date.now();
        atomicWriteTextSync(rotationFile, JSON.stringify(Object.fromEntries(Object.entries(times).sort((a, b) => b[1] - a[1]).slice(0, 40))));
    } finally { await release(); }
}

export async function withRotationLease(scope: string, interval: number, run: () => Promise<void>): Promise<boolean> {
    await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
    const token = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
    const leasePath = path.join(CACHE_ROOT, 'rotation-' + token);
    let release: (() => Promise<void>) | undefined;
    try { release = await lockfile.lock(leasePath, { realpath: false, retries: 0, stale: 30000, update: 5000 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED') { return false; }
        throw error;
    }
    try {
        if (Date.now() - (readTimes()[scope] || 0) < interval * 1000) { return false; }
        await run();
        return true;
    } finally { await release(); }
}

export function startWorkspacePresence(token: () => string): { dispose(): void } {
    const file = path.join(presenceDir, crypto.randomBytes(12).toString('hex') + '.json');
    const beat = () => {
        try { atomicWriteTextSync(file, JSON.stringify({ token: token(), at: Date.now() })); }
        catch (error) { console.warn('[WallpaperStudio] Presence update skipped:', error); }
    };
    beat();
    const timer = setInterval(beat, 30000);
    timer.unref();
    return { dispose: () => { clearInterval(timer); try { fs.unlinkSync(file); } catch { /* Already gone. */ } } };
}

export function activeWorkspaceTokens(): Set<string> {
    const active = new Set<string>();
    const runtimeFile = path.join(CACHE_ROOT, 'runtime.json');
    if (fs.existsSync(runtimeFile)) {
        const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
        Object.keys(runtime.workspaceImages || {}).forEach(key => active.add(key === 'no-workspace' ? 'noworkspace' : key));
    }
    if (!fs.existsSync(presenceDir)) { return active; }
    for (const name of fs.readdirSync(presenceDir)) {
        if (!/^[a-f0-9]{24}\.json$/.test(name)) { continue; }
        const file = path.join(presenceDir, name);
        try {
            const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (typeof entry.token === 'string' && Date.now() - entry.at < 120000) { active.add(entry.token); }
            else { fs.unlinkSync(file); }
        } catch { /* Unavailable session does not prove that a window is active. */ }
    }
    return active;
}

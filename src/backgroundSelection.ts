/** Transient UI selection; successful backgrounds remain the only persisted history. */
interface Selection { path: string; workspace: string | undefined; controller: AbortController; }
let pending: Selection | undefined;
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of listeners) {
        try { listener(); }
        catch (error) { console.warn('[WallpaperStudio] Selection observer failed:', error); }
    }
}

export function onDidChangeBackgroundSelection(listener: () => void): { dispose(): void } {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
}

export function getPendingBackgroundSelection(workspace: string | undefined): string | undefined {
    return pending && pending.workspace === workspace ? pending.path : undefined;
}

export function cancelBackgroundSelection(): void {
    if (!pending) { return; }
    pending.controller.abort();
    pending = undefined;
    changed();
}

export function beginBackgroundSelection(path: string, workspace: string | undefined): { signal: AbortSignal; isCurrent(): boolean; finish(): void } {
    pending?.controller.abort();
    const selection = { path, workspace, controller: new AbortController() };
    pending = selection;
    changed();
    return {
        signal: selection.controller.signal,
        isCurrent: () => pending === selection,
        finish: () => { if (pending === selection) { cancelBackgroundSelection(); } }
    };
}

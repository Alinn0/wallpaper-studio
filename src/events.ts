/** Small host-independent event used by persistent stores and isolated tests. */
export function createEvent<T>(): { event(listener: (value: T) => void): { dispose(): void }; fire(value: T): void } {
    const listeners = new Set<(value: T) => void>();
    return {
        event: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
        fire: value => { for (const listener of listeners) { try { listener(value); } catch (error) { console.warn('[WallpaperStudio] Observer failed:', error); } } }
    };
}

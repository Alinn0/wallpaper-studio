/** Read-modify-write under the shared store lock, with a Memento fallback for legacy callers. */
export async function mutateState<T>(
    state: { get<TValue>(key: string, fallback: TValue): TValue; update(key: string, value: unknown): Thenable<void> },
    key: string, fallback: T, change: (value: T) => T
): Promise<void> {
    const atomic = state as typeof state & { mutate?: (key: string, fallback: T, change: (value: T) => T) => Promise<void> };
    if (atomic.mutate) { await atomic.mutate(key, fallback, change); }
    else { await state.update(key, change(state.get(key, fallback))); }
}

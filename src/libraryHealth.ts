import { createEvent } from './events';
let errorText = '';
const changes = createEvent<string>();
export const onDidChangeLibraryStatus = changes.event;
export function getLibraryError(): string { return errorText; }
export function setLibraryError(error: unknown): void {
    const next = error ? '共享壁纸库不可用：' + (error instanceof Error ? error.message : String(error)) : '';
    if (next !== errorText) { errorText = next; changes.fire(next); }
}

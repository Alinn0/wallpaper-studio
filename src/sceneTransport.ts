import * as crypto from 'crypto';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { cancellationDelay, checkCancellation } from './cancellation';

type Reader = (signal: AbortSignal) => Promise<Buffer>;
interface Asset { key: string; read: Reader; }
interface Receipt { finish(error?: Error): void; }
const readers = new Map<string, Asset>();
const receipts = new Map<string, Receipt>();
const controllers = new Set<AbortController>();
let server: WebSocketServer | undefined;
let starting: Promise<number> | undefined;
let activeReaders = 0;

async function sendAsset(socket: WebSocket, entry: Asset): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    socket.once('close', () => controller.abort());
    let acquired = false;
    try {
        while (activeReaders >= 2) { await cancellationDelay(25, controller.signal); }
        checkCancellation(controller.signal);
        activeReaders++;
        acquired = true;
        const bytes = await entry.read(controller.signal);
        checkCancellation(controller.signal);
        if (socket.readyState === socket.OPEN) {
            await new Promise<void>((resolve, reject) => socket.send(bytes, { binary: true }, error => error ? reject(error) : resolve()));
            socket.close(1000);
        }
    } catch {
        if (socket.readyState === socket.OPEN) { socket.close(1011, 'Cached asset unavailable'); }
    } finally {
        if (acquired) { activeReaders--; }
        controllers.delete(controller);
    }
}

/** Requests identify random capabilities, never disk paths, commands or file uploads. */
async function start(): Promise<number> {
    if (starting) { return starting; }
    starting = new Promise((resolve, reject) => {
        const instance = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 4096, perMessageDeflate: false,
            verifyClient: (info: { req: IncomingMessage }) => {
                const key = (info.req.url || '').split('?')[0];
                return readers.has(key) || receipts.has(key);
            } });
        server = instance;
        instance.once('error', error => { starting = undefined; reject(error); });
        instance.once('listening', () => {
            const address = instance.address();
            if (!address || typeof address === 'string') { reject(new Error('Cache transport has no local port.')); return; }
            resolve(address.port);
        });
        instance.on('connection', (socket, request) => {
            const key = (request.url || '').split('?')[0];
            const receipt = receipts.get(key);
            socket.on('error', () => undefined);
            if (receipt) {
                // One small render result for this exact request; no paths, commands or uploads.
                socket.once('message', (bytes, binary) => {
                    try {
                        const message = JSON.parse(bytes.toString());
                        if (binary || !['ready', 'error'].includes(message.status) ||
                            (message.message !== undefined && typeof message.message !== 'string')) { throw Error('Invalid result'); }
                        receipt.finish(message.status === 'ready' ? undefined : Error(String(message.message || 'Scene render failed').slice(0, 1000)));
                        socket.close(1000);
                    } catch { socket.close(1008); }
                });
                const deadline = setTimeout(() => socket.close(1008), 10000);
                socket.once('close', () => clearTimeout(deadline));
                return;
            }
            const entry = readers.get(key);
            if (!entry) { socket.close(1008); return; }
            socket.on('message', () => socket.close(1008));
            void sendAsset(socket, entry);
        });
    });
    return starting;
}

export async function registerWallpaperAsset(key: string, read: Reader): Promise<string> {
    const port = await start();
    let capability = [...readers].find(([, entry]) => entry.key === key)?.[0];
    if (!capability) { capability = '/' + crypto.randomBytes(32).toString('hex'); }
    readers.delete(capability);
    readers.set(capability, { key, read });
    while (readers.size > 64) { readers.delete(readers.keys().next().value as string); }
    return `ws://127.0.0.1:${port}${capability}`;
}

export interface RenderReceipt { url: string; result: Promise<void>; dispose(): void; }
export async function createRenderReceipt(signal?: AbortSignal, timeout = 120000): Promise<RenderReceipt> {
    const port = await start();
    checkCancellation(signal);
    const capability = '/' + crypto.randomBytes(32).toString('hex');
    let finish!: (error?: Error) => void;
    const abort = () => finish(Error('Scene request cancelled'));
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<void>((resolve, reject) => {
        let settled = false;
        finish = error => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            receipts.delete(capability);
            if (error) { reject(error); } else { resolve(); }
        };
        timer = setTimeout(() => finish(Error('Scene render confirmation timed out')), timeout);
    });
    void result.catch(() => undefined);
    signal?.addEventListener('abort', abort, { once: true });
    receipts.set(capability, { finish });
    return { url: `ws://127.0.0.1:${port}${capability}`, result, dispose: abort };
}

export function disposeSceneTransport(): void {
    readers.clear();
    [...receipts.values()].forEach(receipt => receipt.finish(Error('Wallpaper service reset')));
    controllers.forEach(controller => controller.abort());
    if (server) { server.clients.forEach(client => client.terminate()); server.close(); }
    server = undefined;
    starting = undefined;
}

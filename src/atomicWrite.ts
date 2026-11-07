import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Readers see either the old complete file or the new complete file. */
export function atomicWriteTextSync(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filePath);
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* Already renamed or not created. */ }
    }
}

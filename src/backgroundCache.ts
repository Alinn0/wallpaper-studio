import { normalizeComparablePath } from './pathComparison';

export function backgroundSourceMarker(imagePath: string): string {
    return `/*wallpaper-studio-source:${Buffer.from(normalizeComparablePath(imagePath)).toString('base64')}*/`;
}

export function matchesBackgroundSource(css: string, imagePath: string): boolean {
    return !!imagePath && css.startsWith(backgroundSourceMarker(imagePath));
}

/** Only opacity/blur are patched; media identity, project and user properties stay intact. */
export function patchBackgroundAppearance(css: string, imagePath: string, opacity: number, blur: number): string | undefined {
    if (!matchesBackgroundSource(css, imagePath) || !Number.isFinite(opacity) || !Number.isFinite(blur)) { return undefined; }
    const values = { opacity: Math.max(0, Math.min(0.8, opacity)), blur: Math.max(0, Math.min(100, blur)) };
    const block = /\/\*wallpaper-studio-(scene|video)-start\*\/([\s\S]*?)\/\*wallpaper-studio-\1-end\*\//;
    if (block.test(css)) {
        try {
            return css.replace(block, (_match, kind: string, body: string) => {
                let config: any;
                try { config = JSON.parse(body); } catch {
                    config = JSON.parse(body.replace(/\\`/g, '`').replace(/\\\$\{/g, '${'));
                }
                return `/*wallpaper-studio-${kind}-start*/${JSON.stringify({ ...config, ...values })}/*wallpaper-studio-${kind}-end*/`;
            });
        } catch { return undefined; }
    }
    if (!/body::before\s*\{/.test(css)) { return undefined; }
    return css.replace(/body::before\s*\{([\s\S]*?)\}/, (_match, body: string) => {
        const next = body.replace(/(^|;)\s*opacity\s*:[^;]+/i, `$1opacity:${values.opacity}`)
            .replace(/(^|;)\s*filter\s*:[^;]+/i, `$1filter:blur(${values.blur}px)`);
        return `body::before{${next}}`;
    });
}

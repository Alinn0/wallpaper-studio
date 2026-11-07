'use strict';
// Loaded before any extension module, even when a test is run directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
if (!process.env.WALLPAPER_STUDIO_DATA_DIR) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-studio-test-state-'));
    process.env.WALLPAPER_STUDIO_DATA_DIR = root;
    process.on('exit', () => {
        const resolved = path.resolve(root);
        if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) { return; }
        fs.rmSync(resolved, { recursive: true, force: true });
    });
}

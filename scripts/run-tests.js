'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tests = fs.readdirSync(__dirname).filter(name => /^test-.*\.js$/.test(name) && name !== 'test-env.js').sort();
let failures = 0;
for (const test of tests) {
    const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'test-env.js'), path.join(__dirname, test)], {
        stdio: 'inherit',
        env: { ...process.env, WALLPAPER_STUDIO_DATA_DIR: '' }
    });
    if (result.error) { console.error(result.error); }
    if (result.status !== 0 || result.error) { failures++; }
}
console.log(`${tests.length} test files, ${failures} failed.`);
process.exitCode = failures ? 1 : 0;

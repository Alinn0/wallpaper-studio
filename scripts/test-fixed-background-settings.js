'use strict';
require('./test-env');
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
function load(file, stubs) {
    const filename = path.resolve(file), native = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
        process, Buffer, console, setTimeout, clearTimeout
    }, { filename });
    return module.exports;
}
class Emitter {
    constructor() { this.event = () => ({ dispose() {} }); }
    fire() {}
}
async function main() {
    const file = path.join(process.env.WALLPAPER_STUDIO_DATA_DIR, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ version: 3, blendModel: 'multiply', perWindowBackground: false, opacity: 0.35 }));
    const settings = load('out/settingsStore.js', { vscode: { EventEmitter: Emitter } });
    const config = settings.getAppConfig();
    assert.equal(config.get('blendModel'), 'auto', 'old manual blend must not survive the removed UI');
    assert.equal(config.perWindowBackground, true, 'old shared mode must resolve to folder isolation');
    assert.equal(config.opacity, 0.35, 'unrelated settings remain unchanged');
    await config.update('blendModel', 'lighten');
    await config.update('perWindowBackground', false);
    assert.equal(config.blendModel, 'auto');
    assert.equal(config.get('perWindowBackground'), true);
    await config.update('blur', 2);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.blendModel, 'auto');
    assert.equal(disk.perWindowBackground, true);
    console.log('PASS legacy settings and writes always use automatic blend and folder isolation');

    const runtime = { workspaceImages: {}, workspacePreviousImages: {}, workspacePinnedImages: {}, workspaceStagedImages: {}, workspacePaths: {} };
    function host(folder, session) {
        return load('out/windowBackground.js', {
            vscode: { env: { sessionId: session }, workspace: { workspaceFolders: folder ? [{ uri: { fsPath: folder, scheme: 'file' } }] : [] } },
            './global': { onDidChangeGlobalState: { fire() {} } },
            './settingsStore': { getAppConfig: () => config },
            './runtimeStore': { readRuntimeState: () => runtime, updateRuntimeState: async update => { update(runtime); return true; } }
        });
    }
    const a = host('C:/projects/a', 'window-a'), same = host('C:/projects/a', 'window-b'), b = host('C:/projects/b', 'window-c');
    await a.setCurrentImagePath('a.png');
    await b.setCurrentImagePath('b.png');
    assert.equal(same.resolveCurrentImagePath(), 'a.png');
    assert.equal(b.resolveCurrentImagePath(), 'b.png');
    assert.equal(a.getWindowCssFileName(), same.getWindowCssFileName());
    assert.notEqual(a.getWindowCssFileName(), b.getWindowCssFileName());
    assert.equal(host('', 'empty-a').getWorkspaceKey(), host('', 'empty-b').getWorkspaceKey());
    console.log('PASS same-folder windows share wallpaper/CSS; different folders remain isolated');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

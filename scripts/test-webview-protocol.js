const assert = require('assert').strict;
const { isWebviewMessage } = require('../out/webviewProtocol');
for (const message of [null, [], {type:'unknown'}, {type:'removePlaylistItem',path:'a',mode:'invalid'}, {type:'runAction',action:999}, {type:'setWallpaperProperties',path:'a',properties:[]}, {type:'saveDisplayFps',maxFps:Infinity,overwrite:true}, {type:'openExternal',url:'file:///secret'}, {type:'readThumbnails',keys:[1],requestId:1}]) {
    assert.equal(isWebviewMessage(message), false, JSON.stringify(message));
}
for (const message of [{type:'ready'}, {type:'removePlaylistItem',path:'a',mode:'wallpaper'}, {type:'setWallpaperProperties',path:'a',properties:{x:0}}, {type:'setWallpaperProperty',path:'a',key:'x',value:0}, {type:'openExternal',url:'https://example.com'}, {type:'setConfig',key:'opacity',value:0}]) {
    assert.equal(isWebviewMessage(message), true, JSON.stringify(message));
}
console.log('Webview protocol validation passed');

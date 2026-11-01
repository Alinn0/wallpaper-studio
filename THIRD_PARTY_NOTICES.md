# Third-Party Notices

Wallpaper Studio 在实现过程中参考并使用了以下开源项目。各组件的版权归其作者所有，
按各自许可证条款使用。

---

## 一、参考与衍生的上游项目

### vscode-background-cover

- 项目：https://github.com/AShujiao/vscode-background-cover
- 版权：Copyright (c) 2021 ashujiao
- 许可证：MIT

本项目的**起点**是该项目的代码（内核对 `workbench.desktop.main.js` 的注入方式、
CSS/JS 生成、卸载还原思路均源自该项目）。当前版本已做了大量重构：统一的三种来源
模式、Wallpaper Engine 播放列表与 `.pkg` 场景实时渲染、逐壁纸配置、WebWallGL 集成、
面板 UI 重写等，但派生关系必须在此明确说明。

> Wallpaper Studio 是**独立项目**，不是 vscode-background-cover 的官方版本，
> 与该项目作者无关；上游不为本项目的任何问题负责。

### vscode-background（补丁状态机思路）

- 项目：https://github.com/shalldie/vscode-background
- 版权：Copyright (c) shalldie
- 许可证：MIT

参考其「以内核文件内容标记判定补丁状态」的做法（见 `src/patchState.ts`），
替代原先依赖 `globalState` 记录 VS Code 版本号的方式。

---

## 二、运行时依赖

### WebWallGL

- 版本：3.0.0
- 版权：Copyright (c) 2026 oneincase <462534624@qq.com>
- 许可证：MIT

用于在浏览器环境中解析并渲染 Wallpaper Engine 的 `scene.pkg` 场景包。

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 其他运行时依赖

| 包 | 许可证 | 用途 |
|---|---|---|
| `fs-extra` | MIT | 文件读写 |
| `proper-lockfile` | MIT | 内核文件打补丁时加锁 |
| `async-mutex` | MIT | 串行化渲染任务 |
| `@vscode/sudo-prompt` | MIT | macOS / Linux 提权写内核文件 |

---

## 三、界面依赖

| 包 | 许可证 | 用途 |
|---|---|---|
| Vue 3 | MIT | 面板框架 |
| Element Plus | MIT | 面板组件库 |
| `@element-plus/icons-vue` | MIT | 图标 |
| Vite | MIT | 面板构建 |
| `vite-plugin-singlefile` | MIT | 打包为单文件 HTML |

---

## 四、图形素材

### Material Symbols — `wallpaper`

- 项目：https://fonts.google.com/icons
- 版权：Copyright Google LLC
- 许可证：Apache License 2.0

扩展图标（`resources/wallpaper-studio.png`）与活动栏图标（`resources/activity-bar.svg`）
使用该字形，叠加自绘的渐变底色。字形本身遵循 Apache-2.0，允许修改与再分发。

---

## 五、不包含的素材

本项目**不包含** Wallpaper Engine 客户端本体、Steam 或其创意工坊的任何壁纸资源。
所有壁纸均由用户本地安装的 Wallpaper Engine 提供，仓库中不存放任何 `.pkg` 壁纸资源。

Wallpaper Engine 是 Kristjan Skutta 的商标/产品，与本项目无隶属关系。
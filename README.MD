# Wallpaper Studio

**在你的 VS Code 背景里渲染图片、视频与 Wallpaper Engine 场景包。**

扩展 ID：`Alinn.wallpaper-studio`　版本：`1.0.0`　许可证：MIT

> 中文名「壁纸工作室」。这是一个独立项目，**不是** `background-cover` 的官方版本，
> 详见下方[与 background-cover 的关系](#与-background-cover-的关系)。

---

## 目录

- [与 background-cover 的关系](#与-background-cover-的关系)
- [参考与使用的开源项目](#参考与使用的开源项目)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [打开面板](#打开面板)
- [界面总览](#界面总览)
- [三种来源模式](#三种来源模式)
- [Wallpaper 播放列表模式](#wallpaper-播放列表模式)
- [单张壁纸的设置](#单张壁纸的设置)
- [命令与快捷键](#命令与快捷键)
- [数据存放位置](#数据存放位置)
- [常见问题](#常见问题)
- [从源码构建](#从源码构建)
- [发布到 VS Code Marketplace](#发布到-vs-code-marketplace)
- [开源协议](#开源协议)

---

## 与 background-cover 的关系

Wallpaper Studio **脱胎于** [AShujiao/vscode-background-cover](https://github.com/AShujiao/vscode-background-cover)，
但已经是一个**独立的项目**，不是它的新版、不是它的官方分支，也不由该项目作者维护。

| 项目 | background-cover（上游） | Wallpaper Studio（本项目） |
|---|---|---|
| 扩展 ID | `manasxx.background-cover` | `Alinn.wallpaper-studio` |
| 面板名称 | Background Cover Studio | 壁纸工作室 / Wallpaper Studio |
| 图标 | 上游自带 | 自绘（Material Symbols `wallpaper` 字形 + 渐变底） |
| 内核产物 | `css-background-cover.css` / `js-background-cover.js` | `css-wallpaper-studio.css` / `js-wallpaper-studio.js` |
| 设置目录 | `~/.background-cover/` | `~/.wallpaper-studio/` |
| 命令与视图 ID | `backgroundCover.*` | `wallpaperStudio.*` |
| 维护者 | 上游作者 | 本项目作者 |

需要特别说明的差异：

1. **渲染管线重写**：三种来源模式（本地文件 / 目录媒体 / Wallpaper 播放列表）统一到
   一条管线，随机与自动轮播严格限制在当前模式内，不会串模式取图。
2. **专注 Wallpaper Engine**：支持按当前登录用户读取播放列表、`.pkg` 场景实时渲染、
   逐壁纸保存用户配置项与视角。原本的在线图源、装饰效果、粒子动画、宠物等功能已移除。
3. **完全独立的状态**：扩展 ID 不同，`globalState` / `globalStorage` 目录、
   设置文件目录、内核产物名全部独立，与上游互不干扰，可安全同时安装。

> 如果你要的是上游项目，请访问其仓库。本项目的任何问题请提交到本项目仓库。

---

## 参考与使用的开源项目

本项目站在这些开源工作的肩膀上，感谢它们的作者：

| 项目 | 在本项目中的角色 | 许可证 |
|---|---|---|
| [AShujiao/vscode-background-cover](https://github.com/AShujiao/vscode-background-cover) | **代码起点**：向 `workbench.desktop.main.js` 注入 loader 的方式、CSS/JS 生成、卸载还原思路 | MIT |
| [shalldie/vscode-background](https://github.com/shalldie/vscode-background) | **补丁状态机思路**：用内核文件里的内容标记判定补丁是最新 / 过旧 / 缺失，替代按版本号判断 | MIT |
| [oneincase/WebWallGL](https://www.npmjs.com/package/webwallgl)（`webwallgl@3`） | **场景包渲染**：解析并实时渲染 Wallpaper Engine 的 `scene.pkg` | MIT |
| [Vue 3](https://github.com/vuejs/core) + [Element Plus](https://github.com/element-plus/element-plus) | **面板 UI** | MIT |
| [Vite](https://github.com/vitejs/vite) + [vite-plugin-singlefile](https://github.com/richardtallent/vite-plugin-singlefile) | **面板构建**（产出单文件 HTML） | MIT |
| [Google Material Symbols](https://fonts.google.com/icons) | **图标字形** `wallpaper` | Apache-2.0 |
| `fs-extra` / `proper-lockfile` / `async-mutex` / `@vscode/sudo-prompt` | 文件读写、打补丁加锁、渲染串行化、posix 提权 | MIT |

完整的版权声明与许可证原文见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**本项目不包含任何 Wallpaper Engine 壁纸资源**，所有壁纸都来自你本地安装的
Wallpaper Engine。Wallpaper Engine 是 Kristjan Skutta 的产品，与本项目无隶属关系。

---

## 功能特性

| 能力 | 说明 |
|---|---|
| 图片背景 | png / jpg / webp / gif / bmp / svg 等 |
| 视频背景 | mp4 / webm / ogg / mov / m4v，循环静音播放 |
| 场景包背景 | Wallpaper Engine 的 `scene.pkg`，**在 VS Code 里用 WebGL 实时渲染**，支持鼠标交互与用户配置项 |
| 三种来源模式 | 本地文件 / 目录媒体 / Wallpaper 播放列表，**互斥**，随机与轮播不会串模式 |
| 自动轮播 | 按间隔自动换一张，只在本模式候选池里抽 |
| 每窗口独立 | 每个 VS Code 窗口可以显示不同的壁纸 |
| 逐壁纸设置 | 每张壁纸的配置项与视角（X/Y）独立保存 |
| 热更新 | 切换背景即时生效，无需重启 |

### 工作原理

插件向 VS Code 的 workbench 注入一段 loader，并在安装目录生成两个文件：

```
<VS Code 安装目录>/resources/app/out/vs/workbench/
├── css-wallpaper-studio.css     # 背景样式（共享文件，注入端读这个）
└── js-wallpaper-studio.js       # 加载器
```

因为是写 VS Code 安装目录，**首次应用需要管理员权限**，且 **VS Code 升级/重装后需要
重新应用**（插件会自动提示）。

---

## 环境要求

| 项目 | 要求 |
|---|---|
| VS Code | `^1.38.0` 及以上 |
| 操作系统 | Windows / macOS / Linux（本文以 Windows 为例） |
| 权限 | 首次应用补丁需**管理员**权限 |
| 构建插件 | Node.js 18+（开发机为 v24）、npm 9+ |

> 使用插件本身不需要 Node，只有自己构建才需要。

---

## 安装

### 从 VSIX 安装（推荐）

**图形界面**：扩展面板（`Ctrl+Shift+X`）→ 右上角 `…` → **从 VSIX 安装…** → 选择
`wallpaper-studio-1.0.0.vsix` → 完成后 **重载窗口**。

**命令行**：

```powershell
code --install-extension ".\wallpaper-studio-1.0.0.vsix" --force
```

### 首次运行

1. 状态栏右下角出现 🖼 图标，点击可打开面板；也可点活动栏的 **Wallpaper Studio** 图标
2. 第一次设置背景时会提示修改 VS Code 安装文件 → 点 **应用 / Apply**
3. 写不进去（`EPERM`）时会提示 **以管理员身份重开**：关闭 VS Code → 右键图标 →
   以管理员身份运行 → 再设置一次
4. 成功后可能需要 **重载窗口**

> 之后每次启动 VS Code 都会自动恢复上次的壁纸。

---

## 打开面板

| 方式 | 操作 |
|---|---|
| 活动栏 | 点左侧 **Wallpaper Studio** 图标 |
| 状态栏 | 点右下角 🖼 图标 |
| 命令面板 | `Ctrl+Shift+P` → `Wallpaper Studio - start` |

面板右上角可切换 **界面主题**（默认 / 守望）与 **语言**（中文 / English）。

---

## 界面总览

三个标签页：**首页 / 壁纸列表 / 高级**。

### 首页

| 区域 | 功能 |
|---|---|
| 预览卡 | 当前背景（图片 / 视频 / 场景包首帧）与路径 |
| 上一张 / 随机 | 在**当前模式**候选池里切换（随机不会重复当前这张） |
| 壁纸播放模式 | `本地文件` / `目录媒体` / `Wallpaper 播放列表` |
| 透明度 | `0 ~ 0.8` |
| 模糊度 | `0 ~ 100` |
| 壁纸设置（可折叠） | 当前壁纸的 Wallpaper Engine 配置项 + 视角 X/Y |

> 透明度与模糊度**所有窗口、所有 profile 共用一份**。

### 壁纸列表

第一行按钮随模式变化：

| 模式 | 按钮 |
|---|---|
| 本地文件 | 选择图片 / 视频 / 场景包 |
| 目录媒体 | 添加目录 |
| Wallpaper 播放列表 | **选择 config.json** + **重新读取**（各占一半） |

列表行为：

- 每行显示缩略图（场景包渲染首帧、视频截首帧）与**项目标题**
- **搜索框**：按标题 / 描述 / 路径模糊匹配
- **点击行**：立刻设为背景
- **垃圾桶**：从列表移除（只写插件的移除名单，**不删文件、不改 config.json**）
- **右键行**：在文件资源管理器中定位
- **回到顶部**：列表很长时出现
- 当前壁纸**永远排在第一行**

### 高级

| 卡片 | 说明 |
|---|---|
| 自动随机 | 开关 + 间隔（3～3600 秒），只在本模式候选池里轮播 |
| 窗口背景 | 「每个窗口独立」；关闭则所有窗口共用一张（透明度/模糊度始终统一） |
| 尺寸模式 | 填充 / 平铺 / 拉伸 / 居中 / 原始尺寸（多种对齐） |
| 混合模式 | 自动（跟随主题）/ 正片叠底 / 变亮 |
| 打开缓存目录 | 打开 `globalStorage/Alinn.wallpaper-studio` |
| 清除所有缓存与配置 | 二次确认，清空最近记录、移除名单、壁纸配置项、缩略图与插件设置 |

---

## 三种来源模式

```
本地文件 ────┐
目录媒体 ────┼──► 统一渲染管线（PickList → FileDom）──► VS Code 背景
播放列表 ────┘
```

- 三种模式**互斥**，随机与自动轮播只在本模式候选池里挑
- 模式与候选池由 `src/sourceMode.ts` 统一管理
- 切换模式会立刻在新模式里随机选一张（如果该模式有候选）

---

## Wallpaper 播放列表模式

### 选择 config.json

选中 `<Steam>/steamapps/common/wallpaper_engine/config.json`。插件会记住路径、
清空移除名单、清空目录媒体来源，并重新解析播放列表。

### 重新读取

沿用当前配置文件**强制**重新解析（含清空 `project.json` 缓存），用于在 Wallpaper Engine
里增删壁纸后立即同步。不会修改 config.json，**保留**移除名单。

### 读取的字段

1. **定位播放列表**

   ```
   config.json
    └── <用户名>                          ← 只读当前运行用户（见下）
         └── general.wallpaperconfig.selectedwallpapers
              ├── Monitor0.playlist.items[]
              └── Monitor1.playlist.items[]   ← 多显示器合并去重
   ```

2. **路径解析**：绝对路径 → 相对 config.json 目录 → 相对 `?installdirectory`；
   命中后把 `scene.json` / `project.json` / 项目目录统一转成 `scene.pkg`

3. **类型过滤**（扩展名优先，其次 `project.json` 的 `type`）

   | 输入 | 结果 |
   |---|---|
   | `.pkg` | ✅ 场景包 |
   | `.mp4` `.webm` `.ogg` `.mov` `.m4v` `.avi` `.mkv` | ✅ 视频 |
   | `.html` / `type: web` | ❌ 排除 |
   | `type: application` | ❌ 排除 |

4. **项目元数据**（读 `project.json`）

   | 字段 | 用途 |
   |---|---|
   | `title` | 列表名称（主要检索依据） |
   | `description` | 参与搜索 |
   | `preview` | 预览图，默认 `preview.jpg` |
   | `type` | 类型判定兜底 |
   | `file` | 视频条目指回真实媒体文件 |
   | `general.properties` | 壁纸设置里的全部配置项及声明 |

   按 `project.json` 的修改时间缓存（最多 400 条）。

### 只读当前用户

`config.json` 顶层键是**壁纸引擎账号名**，一台机器上可能有多个账号。插件按以下顺序判定
「当前正在运行的用户」，只读这一个节点：

| 优先级 | 依据 |
|---|---|
| 1 | 上次记住的用户（仍存在于 config 里） |
| 2 | **当前系统登录名** |
| 3 | Steam `loginusers.vdf` 的 `PersonaName` / `AccountName` |
| 4 | 唯一一个播放列表非空的真实用户节点 |
| 5 | 第一个真实用户节点 |

- `?` 开头的键（如 `?installdirectory`）是元数据，不算用户
- `defaultuser<数字>` 是未登录/默认节点，**永不当成真实用户**
- 换账号时自动清缓存并整份重读
- 找不到当前用户、或该用户播放列表为空时提示：**请在 wallpaper 播放列表里面添加壁纸**

---

## 单张壁纸的设置

首页 → **壁纸设置** → 展开「壁纸设置」。

### 项目配置项

按 `project.json` 的 `general.properties` 自动生成控件：

| 类型 | 控件 |
|---|---|
| `bool` | 开关 |
| `color` | 颜色选择器 |
| `combo` | 下拉框 |
| `slider` | 滑块（带真实范围与步长） |
| `text` / 其他 | 输入框 |
| `group` / `header` / `label` | 分组标题 / 说明文字 |

**修改即刻生效**：值会写回场景的 `{user:...}` 绑定，画面实时重渲染，无需重启。

### 视角 X / Y

| 项 | 说明 |
|---|---|
| 水平视角 X | `0 ~ 200`，默认 `100` |
| 垂直视角 Y | `0 ~ 200`，默认 `100` |
| 重置视角 | 回到 `100 / 100` |

- **纯平移**：画面尺寸恒为 100%，`left = (X-100)/100 × 50%`，不做自动放大
- 推到端点会**露出空白**，这是预期行为（平移与缩放已解耦）
- 默认 `100 / 100` 时位移为 0

### 逐壁纸独立保存

每张壁纸的配置值与视角都按「壁纸规范化路径」独立存储：A 的视角不影响 B，
没设置过的壁纸不会残留别人的值；视频 / 图片 / 目录媒体这类没有 `project.json`
的壁纸也能读回视角。

---

## 命令与快捷键

| 命令面板标题 | 命令 ID | 作用 |
|---|---|---|
| `Wallpaper Studio - start` | `extension.wallpaperStudio.start` | 打开面板 |
| `Wallpaper Studio - refresh` | `extension.wallpaperStudio.refresh` | 立刻随机换一张 |
| `首页` | `wallpaperStudio.home` | 打开面板并跳到首页 |
| `配置` | `wallpaperStudio.switchMode` | 打开面板并跳到首页 |
| `刷新`（视图标题栏） | `wallpaperStudio.refreshEntry` | 刷新面板数据 |

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Shift+F7` | 随机换一张背景 |

---

## 数据存放位置

| 内容 | 路径 |
|---|---|
| 共享设置（透明度/模糊度/自动轮播/尺寸/混合模式等） | `%USERPROFILE%\.wallpaper-studio\settings.json` |
| 当前背景与窗口/工作区运行状态 | `%USERPROFILE%\.wallpaper-studio\runtime.json` |
| 缩略图缓存 / 场景预览页 | `<VS Code User>/globalStorage/Alinn.wallpaper-studio/` |
| 移除名单 / 逐壁纸配置 / 最近使用 | VS Code `globalState` |
| 背景样式与加载器 | `<VS Code 安装目录>/resources/app/out/vs/workbench/css-wallpaper-studio.css`、`js-wallpaper-studio.js` |

### 后台保活（自动）

- 每 **5 秒**把当前窗口样式镜像到共享的 `css-wallpaper-studio.css`
  → 下次打开 VS Code 立刻就有背景
- 同时清理 **超过 60 秒**的旧会话样式文件（`css-wallpaper-studio.<session>.css`）
  → 缓存不会越堆越大

---

## 常见问题

### Q1. 提示需要管理员权限 / 写入失败

关闭 VS Code → 右键 **以管理员身份运行** → 重新设置背景。macOS / Linux 会通过
`sudo` 弹窗提权。

### Q2. 启动时提示「背景补丁缺失或版本过旧」

说明 VS Code 升级、重装，或你手动还原过 workbench 文件。点 **应用 / Apply** 即可。

### Q3. VS Code 报告「安装似乎损坏」

**不要点「还原 / Restore」**（那会把补丁覆盖回去，插件就失效了）。正确做法：
关闭后重新打开，等插件自动重新应用；仍报错就点「应用」重打一次。

插件已做保护：写补丁前校验壁纸是否存在；清除背景时保留损坏提示抑制 CSS。

### Q4. 换了壁纸目录后背景不显示

旧版本会把**已不存在的路径**写进 patch。现在应用前会检查文件是否存在，缺失时直接提示。

### Q5. 场景包比预览图模糊

历史原因是渲染器默认按 `max(0.6, min(1, dpr/2))` 缩放纹理，dpr=1 的屏幕会得到 0.6 倍。
现在场景预览页固定使用 `?resources=native`，纹理按原生分辨率加载。另外确认首页的
**模糊度**是否为 0。

### Q6. 场景包点了没反应

- 项目里是否真的有 `scene.pkg`（只有 `scene.json` 的项目会自动映射）
- 类型是否为 `scene`（`web` / `application` 会被排除）
- 右键该行 →「在文件资源管理器中打开」，确认文件还在

### Q7. 壁纸列表是空的

- 是否提示「请在 wallpaper 播放列表里面添加壁纸」→ 去 Wallpaper Engine 客户端加一张
- 是否点过垃圾桶把壁纸都移除了 → 重新「选择 config.json」清空移除名单
- 只支持场景包与视频，网页 / 应用程序壁纸不会出现在列表里

### Q8. 切换 profile 后透明度拉满

共享设置文件是跨 profile 的唯一来源，透明度/模糊度都会做范围收敛。仍异常时到
「高级 → 清除所有缓存与配置」重置。

---

## 从源码构建

### 前置

```powershell
node -v      # >= 18
npm.cmd install
```

> Windows 下建议用 `npm.cmd`，避免 PowerShell 执行策略拦截 `npm.ps1`。

### 目录结构

```
├── src/                       # 扩展宿主（TypeScript）
│   ├── extension.ts           # 激活入口：命令、状态栏、软写入
│   ├── StudioViewProvider.ts  # 面板 ↔ 扩展桥接
│   ├── PickList.ts            # 渲染管线、自动轮播
│   ├── FileDom.ts             # workbench 补丁、CSS/JS 生成、场景 iframe
│   ├── patchCleanup.ts        # 补丁标记与清理
│   ├── patchState.ts          # 补丁状态机
│   ├── wallpaperEngine.ts     # config.json / project.json 解析
│   ├── sourceMode.ts          # 三种模式的唯一真源
│   ├── settingsStore.ts       # 共享设置文件
│   ├── thumbnailStore.ts      # 缩略图持久缓存
│   └── backgroundSoftWrite.ts # 软写入保活
├── webview/                   # Vue 3 + Element Plus 面板（Vite 构建）
├── resources/                 # 场景预览页、图标
├── scripts/                   # 回归测试脚本
├── out/                       # tsc 产物（打包用）
└── webview-dist/              # Vite 产物（单文件 index.html）
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm.cmd run compile` | TypeScript 编译到 `out/` |
| `npm.cmd run watch` | 增量编译（调试用） |
| `npm.cmd run build:webview` | 构建 Vue 面板 |
| `npm.cmd run watch:webview` | 面板热更新 |
| `npm.cmd run test:unit` | 编译 + 全部回归测试 |
| `npm.cmd run package` | 打包 VSIX（自动先构建面板再编译） |

### 标准重构流程

```powershell
npm.cmd run build:webview    # 改了 webview/
npm.cmd run compile          # 改了 src/
npm.cmd run test:unit        # 跑测试
npm.cmd run package          # 打包
code --install-extension ".\wallpaper-studio-1.0.0.vsix" --force
# 重载窗口生效
```

> `out/` 和 `webview-dist/` 只是中间产物，真正运行的是安装到 VS Code 扩展目录的那份。

### 调试（不打包）

1. 用 VS Code 打开本仓库
2. 按 `F5` → **Run Extension**（会自动 `npm: watch`）
3. 在开发宿主窗口里验证；扩展侧改动在调试面板点 **重启**
4. 面板改动另开终端 `npm.cmd run watch:webview`，重载面板

### 回归测试

`npm.cmd run test:unit` 依次执行：

| 脚本 | 覆盖内容 |
|---|---|
| `test-config-update.js` | 设置读写与迁移 |
| `test-auto-refresh.js` | 自动轮播 / 目录媒体候选 |
| `test-source-isolation.js` | 三种模式候选互不重叠（13 条断言） |
| `test-wallpaper-user.js` | 只读当前用户播放列表（13 条断言） |
| `test-soft-write.js` | 软写入与旧会话清理（9 条断言） |
| `test-new-features.js` | CSS / 补丁 / 场景相关产物断言 |
| `test-wallpaper-pkg.js` | `.pkg` 探测与场景输入 |

### 安装位置（排查用）

```
%USERPROFILE%\.vscode\extensions\alinn.wallpaper-studio-<版本>\
```

---

## 卸载与还原

```powershell
code --uninstall-extension Alinn.wallpaper-studio
```

卸载脚本会尝试还原被修改的 workbench 文件（`.bak` 备份）。若目录需要管理员权限，
还原可能失败，此时以管理员身份重开 VS Code 后再卸载，或手动删除：

```
<VS Code 安装目录>/resources/app/out/vs/workbench/
├── css-wallpaper-studio.css
├── js-wallpaper-studio.js
├── wallpaper-studio-assets/
├── wallpaper-studio-scene.html
├── wallpaper-studio-scene.js
└── wallpaper-studio-webwallgl.js
```

并把 `workbench.desktop.main.js.bak` 覆盖回 `.js`。

清理残留数据（可选）：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.wallpaper-studio"
Remove-Item -Recurse -Force "$env:APPDATA\Code\User\globalStorage\Alinn.wallpaper-studio"
```

---

## 发布到 VS Code Marketplace

> 不需要公司、出版商资质或域名。个人开发者即可发布，唯一成本是时间。

### 一次性准备

**1. 创建 Publisher**

打开 <https://marketplace.visualstudio.com/manage> → 用 Microsoft 账号登录 →
**Create publisher**，ID 填 `Alinn`（必须与 `package.json` 的 `publisher` 一致）。
"Publisher" 只是自取的名字，没有审核、不收费。

**2. 生成 PAT**

<https://dev.azure.com/_usersSettings/tokens> → **New Token**：

| 项 | 值 |
|---|---|
| Organization | `All accessible organizations`（选单一组织会 403） |
| Scopes | Show all scopes → **Marketplace** → **Manage** |

### 发布

```powershell
cd "E:\Study\Vscode For Wallpaper Engine"

.\node_modules\.bin\vsce.cmd login Alinn      # 粘贴 PAT，会存到 ~/.vsce
.\node_modules\.bin\vsce.cmd publish          # 首次发布 1.0.0
.\node_modules\.bin\vsce.cmd publish patch    # 之后升版本：1.0.0 → 1.0.1
```

`vscode:prepublish` 会自动执行 `clean → build:webview → compile`，无需手动构建。
已有 VSIX 想直接上传：`vsce publish --packagePath .\wallpaper-studio-1.0.0.vsix`。

### 不发布也能分发

| 方式 | 说明 |
|---|---|
| VSIX | 分发 `wallpaper-studio-1.0.0.vsix`，对方执行 `code --install-extension xxx.vsix --force` |
| GitHub Releases | 把 VSIX 挂到 Release，用户手动下载安装 |
| Open VSX | `npx ovsx publish .\wallpaper-studio-1.0.0.vsix -p <token>`（VSCodium / Cursor） |

### 常见报错

| 报错 | 处理 |
|---|---|
| `Publisher 'Alinn' not found` | Publisher 未创建，或 ID 与 `package.json` 不一致 |
| `401 / 403` | PAT 组织没选 `All accessible organizations`，或没勾 Marketplace → Manage |
| `Icon file is not a PNG` | 图标必须是 128×128 PNG |
| `Extension entrypoint is missing` | `.vscodeignore` 误排了 `out/` |

> 本扩展会改写 VS Code 安装目录里的 workbench 文件，首次提交可能进入人工审核队列。

---

## 开源协议

本项目以 **MIT License** 发布，见 [LICENSE](./LICENSE)。

```
MIT License

Copyright (c) 2026 Alinn

Portions of this software are derived from "vscode-background-cover"
(https://github.com/AShujiao/vscode-background-cover),
Copyright (c) 2021 ashujiao, also released under the MIT License.
```

上游 `vscode-background-cover` 与本项目同为 MIT，因此派生与再发布是允许的，
其原始版权声明已保留在上面的 LICENSE 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 中。
第三方组件（WebWallGL、Vue、Element Plus、Material Symbols 等）按其各自许可证使用，
完整清单与许可证原文见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 致谢

感谢 [ashujiao](https://github.com/AShujiao) 的 vscode-background-cover、
[shalldie](https://github.com/shalldie) 的 vscode-background、以及 WebWallGL 的作者，
没有这些开源工作就没有这个项目。
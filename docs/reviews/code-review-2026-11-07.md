# 项目代码审查报告

审查日期：2026-11-07。审查基于当前工作区，包含已有的 package.json / package-lock.json 修改。

后续：本报告保留为修复前审查快照。1.0.2 的修复、验证及安装状态见 [进度书验收归档](../progress/进度书.md#task-acceptance-history) 和 [计划书第五十三节](../planning/计划书.md)。

覆盖扩展启动与命令、背景应用与注入、运行时和设置存储、Wallpaper Engine 配置读取、Vue 面板与预览、缓存、卸载、测试和构建配置。采用静态审查、现有检查和内存隔离复现；未在真实 VS Code 窗口中做交互验收，也未验证 macOS / Linux 实机。

发现 13 项问题。P1 表示优先处理的数据一致性、状态串写、测试污染或权限问题；P2 表示功能缺陷或平台兼容问题。本文是审查结果，未修改业务源码。

**验证结果**

- 扩展 TypeScript 编译通过，TSLint 通过。
- Webview 类型检查及生产构建通过，产物约 519.70 kB（gzip 150.26 kB）。构建存在 inlineDynamicImports 和第三方 PURE 注释警告，不阻断构建。
- 原始 npm.cmd run test:unit 在 test-config-update.js 处失败，共 7 项断言失败；该命令使用 &&，因此后续测试未执行。
- 将其余 8 份测试脚本逐份运行，全部通过。
- 仅在内存中为配置测试补充 runtimeStore 夹具后，该组 10 项测试全部通过。因此原始 7 项失败不能直接当作透明度 / 模糊度的产品回归。
- 下列复现使用内存文件系统、依赖桩或直接执行提取的源码函数，不修改 VS Code 安装文件。

**1. [P1] 背景应用失败仍返回成功，并保存失败路径**

定位：[PickList.ts:736](../../src/PickList.ts#L736)、[PickList.ts:780](../../src/PickList.ts#L780)、[PickList.ts:920](../../src/PickList.ts#L920)。

updateDom() 在非静默路径中捕获错误并返回 false；setConfigValue() 不检查应用是否成功，继续调用 setCurrentImagePath()；updateBackgound() 最后无条件返回 true。false 在现有接口中同时表示失败和成功但无需重载，因此无法可靠表达结果。历史列表还在应用前写入。

复现：令 FileDom.install() 抛错，applyBackgroundPath('C:/missing.png', {silent:true}) 返回 true，保存路径为 missing.png；令 install() 返回 false，同样保存失败路径。自动轮播因此可能误判成功并停止重试。

另一个相关缺陷是 applyBackgroundPath() 的 silent 只调用 setRandUpdate(true)，没有设置实际传给 FileDom 的 silentApply。复现中 FileDom 收到 silent:false，并调用了 showErrorMessage。

建议：应用结果改为明确的 {applied, requiresReload}；仅在 applied 且请求仍有效时写当前路径及历史；把 silent 选项传到实际写入层，并验证失败重试不会弹窗。

**2. [P1] 共享设置在其他已打开窗口中不会自动同步**

定位：[settingsStore.ts:155](../../src/settingsStore.ts#L155)、[settingsStore.ts:230](../../src/settingsStore.ts#L230)、[extension.ts:110](../../src/extension.ts#L110)。

load() 优先返回进程缓存，只有本进程调用 update() 才重新读盘；没有 settings.json 文件监听。onDidChangeSettings 也是进程内事件。窗口 B 改透明度、自动轮播或独立 / 共享模式后，窗口 A 会继续使用旧设置和定时器。即使解决缓存刷新，现有扩展监听器也只重新应用 perWindowBackground，其他影响背景的共享配置还需补齐应用逻辑。

内存双实例复现：A、B 初始 opacity 都为 0.2；B 保存 0.6 后，磁盘与 B 为 0.6，A 仍为 0.2，A 收到的事件数为 0。

建议：监听文件并合并外部变化，广播变化键并重新应用对应状态；写设置采用跨进程锁和原子替换。当前无锁的读改写也可能在多进程并发时丢更新。

**3. [P1] 设置落盘失败后，内存却已更新，调用方也收不到失败**

定位：[settingsStore.ts:325](../../src/settingsStore.ts#L325)。

reloadFromDisk() 返回的对象就是 cache；update() 先修改它，再调用 persist()。持久化失败时只是 return，既不恢复缓存也不向调用方报告失败，后续读取 / 应用可能继续使用未保存的值。

复现：磁盘 opacity=0.6，模拟 writeFileSync 失败后调用 update('opacity',0.7)，磁盘仍是 0.6，readSettings().opacity 已变成 0.7。

建议：在副本上修改，写入成功后再提交缓存；通过异常或显式结果告知命令层失败，禁止应用未保存的设置。

**4. [P1] 拖动属性后立即换图，会把旧壁纸的属性写到新壁纸**

定位：[HomeTab.vue:326](../../webview/src/views/HomeTab.vue#L326)、[HomeTab.vue:386](../../webview/src/views/HomeTab.vue#L386)、[HomeTab.vue:408](../../webview/src/views/HomeTab.vue#L408)。

属性和 XY 滑块的 60ms 延迟回调在执行时读取 config.imagePath。切换壁纸只重置 XY 脏状态，没有取消待发任务。

执行源码函数复现：在 A.pkg 修改 speed=9，回调触发前切到 B.pkg，最终消息为 {path:'B.pkg',key:'speed',value:9}。XY 回调同样会错发到 B，并可能使用切换后重置的值。

建议：排队时捕获壁纸路径和值；定时器按路径和属性键管理；换图和组件卸载时取消或按原路径提交待发修改。

**5. [P1] 播放列表旧请求会覆盖新请求，并污染新配置的缓存**

定位：[StudioViewProvider.ts:1096](../../src/StudioViewProvider.ts#L1096)、[StudioViewProvider.ts:1142](../../src/StudioViewProvider.ts#L1142)、[StudioViewProvider.ts:1167](../../src/StudioViewProvider.ts#L1167)。

force 分支绕过原有 Promise，旧任务并未失效；普通合并也没有按配置文件区分。异步完成后，代码直接写入实例状态，并使用此刻的 this.wallpaperConfigPath / wallpaperUser 保存缓存。

复现：old.json 开始读取；改成 new.json 并强制读取；新请求先完成，旧请求后完成。最终配置仍是 new.json，显示列表却为 OLD.pkg，缓存也把 OLD.pkg 记在 new.json 下。

建议：为每次请求分配递增版本号，并捕获 configPath、user、removed 等输入；仅最新请求可提交状态和缓存。合并键必须包括这些输入。

**6. [P1] 测试没有隔离真实 runtime.json，会污染用户壁纸记录**

定位：[test-config-update.js:97](../../scripts/test-config-update.js#L97)、[test-config-update.js:147](../../scripts/test-config-update.js#L147)、[test-auto-refresh.js:120](../../scripts/test-auto-refresh.js#L120)、[runtimeStore.ts:7](../../src/runtimeStore.ts#L7)。

测试替换了 settingsStore 和 VS Code API，却仍加载真实 runtimeStore。轮播测试通过 setCurrentImagePath() 持久化临时文件，而 runtime.json 路径固定使用 os.homedir()；mock context.globalStorageUri 并不能隔离它。测试结束删除临时目录，真实运行时里留下不存在的图片路径。

本次运行后实际确认：no-workspace 记录指向已删除的 bgc-auto-refresh-DoZqB5/wallpapers/two.webp。已在持锁、备份后只删除这条精确匹配的失效测试记录，其余 12 条工作区图片记录保持不变。清理前备份保存在系统临时目录 wallpaper-studio-audit-runtime-eb55643a-9231-42e8-814e-e4d8281009e7.json。

配置测试的 7 项失败还有夹具过时原因：它只设置 settings.imagePath，实际背景解析已改查 workspaceImages。为 runtimeStore 注入内存夹具后该组全部通过。

建议：存储目录允许注入，所有测试使用独立临时 home / runtime；测试结束验证真实用户存储未被访问。补充失败应用、跨窗口同步和并发请求的行为测试，避免仅通过字符串检查或替换 updateDom 掩盖缺陷。

**7. [P1] 提权后开放整个 workbench 目录给所有用户写入**

定位：[FileDom.ts:89](../../src/FileDom.ts#L89)、[FileDom.ts:382](../../src/FileDom.ts#L382)、[FileDom.ts:387](../../src/FileDom.ts#L387)。本项来自静态审查，未执行权限命令。

Windows 授予 Users:(OI)(CI)F，macOS / Linux 执行 chmod a+rwx。授权对象是包含 workbench 脚本的安装目录，范围超过壁纸资源；卸载也没有恢复这些 ACL / 权限。

建议：背景资源放入用户可写目录；需要修改安装文件时，仅提权执行必要的具体写入，不永久开放目录给所有用户。如必须调整权限，应限定当前用户并记录和恢复原权限。

**8. [P2] 删除最后一张当前壁纸时，空路径反而重新应用原壁纸**

定位：[StudioViewProvider.ts:849](../../src/StudioViewProvider.ts#L849)、[PickList.ts:736](../../src/PickList.ts#L736)。

removePlaylistItem 没有剩余候选时传入空字符串，但 updateBackgound() 把空字符串解释为使用当前路径。复现：当前为 C:/last.png，applyBackgroundPath('') 最终仍应用并保存 last.png。

建议：区分 undefined（复用当前壁纸）和空字符串（明确清空）；删除最后一项时直接进入统一清空分支。

**9. [P2] 图片 / 视频的 XY 调整不能正确作用于实际背景**

定位：[StudioViewProvider.ts:923](../../src/StudioViewProvider.ts#L923)、[FileDom.ts:1543](../../src/FileDom.ts#L1543)、[FileDom.ts:1567](../../src/FileDom.ts#L1567)、[FileDom.ts:2705](../../src/FileDom.ts#L2705)。

属性应用只对 pkg 修改 CSS；图片 / 视频仅推送面板状态。图片即使完整重新应用，也用已转换的 vscode-file URI 查询覆盖值，而保存时使用本地路径。视频配置则未包含 XY，applyVideo 也未设置 object-position。

复现：本地路径 C:/pics/a.png 保存 pan_x=0，getCss() 用原始路径时输出 0% 50%；改成真实渲染使用的 vscode-file://vscode-app/C:/pics/a.png 后输出 center。

建议：保留原始媒体路径作为属性键；图片更新 background-position，视频更新 object-position，并在拖动时触发对应轻量应用。

**10. [P2] 本地文件模式的“上一张”可以切入其他模式**

定位：[StudioViewProvider.ts:788](../../src/StudioViewProvider.ts#L788)、[StudioViewProvider.ts:1041](../../src/StudioViewProvider.ts#L1041)、[sourceMode.ts:145](../../src/sourceMode.ts#L145)。

随机候选会排除播放列表 / 目录媒体，上一张的 isInMode(file) 却仅检查最近历史，而历史包含所有模式的切换结果。

复现：file 模式下历史为 local.png、playlist/scene.pkg、older.png，点击上一张实际发送应用 playlist/scene.pkg 的命令。

建议：上一张复用 getCandidatesForMode() 的同一份成员集合，并过滤已删除或不可读的路径。

**11. [P2] 视频类型支持列表不一致，列表可导入但背景按图片处理**

定位：[wallpaperEngine.ts:213](../../src/wallpaperEngine.ts#L213)、[pathUtil.ts:47](../../src/pathUtil.ts#L47)、[media.ts:5](../../webview/src/utils/media.ts#L5)。

播放列表将 m4v / avi / mkv 判为视频；FileDom 使用的 isVideoFile 只接受 mp4 / webm / ogg / mov；前端还有第三份名单。复现：classifyWallpaperPath('a.m4v') 为 video，isVideoFile('a.m4v') 为 false，因此实际背景会生成 background-image 而非视频配置。

建议：共用一份媒体能力定义，同时区分扩展名识别与实际可解码性，不支持的类型给出明确提示。

**12. [P2] VS Code 视图标题栏的刷新按钮不刷新数据**

定位：[extension.ts:157](../../src/extension.ts#L157)、[StudioViewProvider.ts:612](../../src/StudioViewProvider.ts#L612)。

refreshEntry 调用 refresh()，后者只发送当前加载进度，不读取配置、不刷新目录缓存，也不调用 pushState()。内存桩复现调用次数：progress=1，state=0，sync=0。面板内部另一个刷新按钮发送 ready，行为也因此不一致。

建议：统一刷新入口，明确失效哪些缓存，重新读取并推送完整状态。

**13. [P2] 路径统一转小写会破坏区分大小写平台的隔离**

定位：[windowBackground.ts:65](../../src/windowBackground.ts#L65)、[pathComparison.ts:5](../../src/pathComparison.ts#L5)、[wallpaperEngine.ts:36](../../src/wallpaperEngine.ts#L36)。本项由静态逻辑确认，未在 Linux 实机运行。

例如 Linux 上 /work/A 与 /work/a 可以是不同目录，但 getWorkspaceKey() 对二者生成相同输入和哈希，使用同一壁纸记录和 CSS；媒体比较和属性覆盖键也会把仅大小写不同的文件合并。

建议：至少按平台决定大小写归一化，仅在明确不区分大小写的路径环境折叠大小写；工作区键保留 URI scheme / authority，防止不同远程位置仅因 fsPath 相同而合并。

**可以优化的地方**

1. 场景包重复读写与容量管理：[wallpaperScene.ts:82](../../src/wallpaperScene.ts#L82) 每次先完整哈希，再无条件复制，已有同哈希副本也会重写。按源文件签名缓存哈希，目标存在则复用；为 wallpaper-studio-assets 增加容量上限和在用引用保护。当前运行期间没有包缓存回收，壁纸更新会持续留下新副本。
2. 缩略图批量落盘：[StudioViewProvider.ts:459](../../src/StudioViewProvider.ts#L459) 虽合并了 800ms 写入，但每张图仍单独同步写文件、排序淘汰并完整写索引。改成 setMany()，每批裁剪和写索引一次；减少主线程同步 IO，并处理多个窗口的索引合并。
3. 原子持久化：[runtimeStore.ts:83](../../src/runtimeStore.ts#L83) 与 settingsStore 直接覆盖 JSON 文件。改为持锁写同目录唯一临时文件再替换，减少截断 / 半写文件风险；首次创建和迁移也应进入同一锁协议。updateRuntimeState() 还会调用 mutator 两次，第一次计算的 next 未被使用，宜移除无效计算。
4. 预览缓存失效：首页场景缩略图仅按路径查询基线，watch 未包含属性变化，有缓存时直接跳过精确渲染；同路径文件更新也没有 mtime / size 参与缓存键。可保留旧图快速显示，再根据文件签名和属性哈希升级精确帧；内存缩略图及精确属性帧需要 LRU 上限。
5. 模块职责：FileDom.ts 和 StudioViewProvider.ts 体积较大，建议拆为补丁写入、背景应用结果、运行时通信、列表加载和缓存模块。优先统一应用结果、媒体能力和路径键，再拆分，避免搬动代码却保留分叉语义。
6. 构建复现性：build:webview 每次 npm install，审查 / 打包会隐式重新解析依赖。将依赖安装与构建分开，CI 使用锁文件安装；补充固定 Node 版本和自动检查流程。同步修正文档中的 VS Code / Node 最低版本及发布版本描述。

建议处理顺序：先修复应用结果、设置写入事务、测试隔离及异步请求版本；再处理跨窗口同步、属性路径和来源隔离；最后做大文件 IO、缓存和结构优化。每项修复配合对应失败场景的行为测试。

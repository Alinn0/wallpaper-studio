# 设置存储与共享范围（2026-11-08，最终更新）

本文件以最新实现为准，替代同日早先“列表、属性按 Profile 保存”的结论。扩展版本 1.0.2。

| 范围 | 数据 | 保存位置 |
| --- | --- | --- |
| 所有窗口、工作区、Profiles | opacity、blur、targetFps、maxFps、autoStatus、autoInterval、randomImageFolder、sizeModel、blendModel、perWindowBackground | ~/.wallpaper-studio/settings.json |
| 所有窗口、工作区、Profiles | 三模式来源选择、本地导入列表、Wallpaper 配置路径/用户、列表移除项、同壁纸属性和视角 | ~/.wallpaper-studio/library.json |
| 按工作区保存，跨 Profiles 读取 | workspacePaths、workspaceImages、workspacePreviousImages、workspacePinnedImages、待重载的 workspaceStagedImages | ~/.wallpaper-studio/runtime.json |
| Profile 默认值 | 界面语言、扩展/编辑器升级与清理标记 | VS Code 原生 globalState，未路由到共享库 |
| 面板自身 | 标签、主题、语言覆盖 | Webview getState/setState |
| 当前渲染窗口或宿主内存 | 实际 FPS、屏幕采样、轮播计时、请求取消、图库内存缓存 | 内存 |
| 可淘汰缓存 | 场景包、缩略图、预览运行页 | ~/.wallpaper-studio/scene-assets（最多 5 包）、thumbnails、scene-preview |
| 窗口内存 | 切换覆盖帧、前端预览图片 | 工作台最多 8 个覆盖帧；首页与图库共用最多 300 项 / 1200 万字符的缩略图预算，不写 localStorage |
| 同一显示范围协调 | 轮播成功时间、待处理选择、活跃宿主 | rotation.json、pending-loads.json、sessions/；作用域是工作区或关闭独立背景后的 shared |

“整体共享”指同一操作系统用户使用同一个数据目录；不等于跨设备云同步。WALLPAPER_STUDIO_DATA_DIR 可改变目录。文件夹模式扫描同一个 randomImageFolder，Wallpaper 模式读取同一个配置文件和用户，本地模式读取同一导入列表；三种来源不会混成一个列表。同路径壁纸在不同模式下共用属性和视角。

## 初始化、同步与迁移

- 新版首次激活在文件锁内创建 library.json，从首个激活 Profile 导入现有有效列表和参数。旧混合播放历史不导入。
- 已有共享库时直接读取；后续 Profile 的旧列表不会自动合并，避免覆盖新参数或复活已移除项目。其他 Profile 的独有旧数据仍留在原存储中，需要显式重新导入。
- 列表增删、属性修改均在锁内读最新数据后合并；原子替换失败不更新成功状态；损坏文件不会被空库覆盖。
- 每 500ms 监听共享库文件变化；面板按需更新列表，未打开面板时也可更新当前背景的属性。属性变化不触发整份图库扫描。
- 属性按规范化文件路径定位；Windows 大小写和斜杠差异视为同一路径。不同位置的副本是不同壁纸。
- library.json 不保存当前壁纸，因此共享参数不会直接改变其他工作区当前播放项。
- runtime.json 按第一个工作区目录计算键；空窗口共用 no-workspace。每 500ms 检查外部写入，面板实时更新，工作台收到轻量 CSS 重读通知。
- 同一显示范围的多个宿主共用轮播锁及成功时间；手动切换优先于自动切换，外观更新不会取消待选壁纸。
- 共享库损坏时保留原文件并显示恢复提示；重置先备份现有状态，失败会报告。重置涉及多个文件，可能部分完成；备份保留，修复失败原因后可重试。
- 初次部署用首个希望保留列表的 Profile 激活新版。实际构建安装状态以进度书最新记录为准。

## 配置字段清理

settings.json 删除已无用途的 forceHttpsUpgrade、seeded；保留 version（结构迁移）和 imagePath（旧全局背景兜底，不再作为当前背景写入点）。
runtime.json 不再保存 windowOpacity、workspaceOpacity、windowBlur、workspaceBlur。旧 Profile 的重复 WallpaperEnabled、默认模式强制迁移、在线源和历史记录在启动时清理，不参与新版读取。
本机两个文件已备份至 D:/Users/Alinn/.wallpaper-studio/backups/config-cleanup-2026-11-08T02-22-11-104Z/ 后整理，保留原透明度、轮播间隔、目录及 12 个背景记录。

## FPS 边界

目标默认 60、最低 15；最大值 maxFps 首次打开首页且无已保存值时用 rAF 估算并写入共享 settings.json。后续启动、焦点/尺寸变化和场景加载直接复用，不重新采样。目标 FPS 文本框右侧按钮强制重新读取当前屏幕，并更新所有窗口、工作区与 Profiles；若新上限低于目标，目标会同步降到上限。场景使用 min(targetFps, maxFps)，尚未检测时临时按 60 上限渲染，预览固定 24 FPS。切换显示器后可点击按钮更新；不再维护每个窗口独立的检测上限。rAF 仍是估算，真实多屏、可变刷新率及高负载环境验收保留。

<!--
 * @Description: Wallpaper Studio 更新日志
 * @FilePath: \wallpaper-studio\CHANGELOG.md
-->
## 更新日志

> **版本说明**：Wallpaper Studio 是一个独立项目，扩展 ID 为 `Alinn.wallpaper-studio`。
> 版本号自 `1.0.0` 起算，与上游 `background-cover` 的版本序列无关。

#### ver 1.0.0 (2026/11/01)

    Wallpaper Studio 首个正式版本。

    1. 定位：独立的 VS Code 背景扩展，扩展 ID Alinn.wallpaper-studio，
       命令/视图/全局变量/globalState 键统一为 wallpaperStudio 前缀，
       内核产物为 css-wallpaper-studio.css / js-wallpaper-studio.js。
    2. 渲染：三种来源模式（本地文件 / 目录媒体 / Wallpaper 播放列表）统一为单一管线，
       随机与自动轮播严格限制在当前模式内，不再跨模式取图。
    3. 场景包：在 VS Code 背景中实时渲染 Wallpaper Engine 的 .pkg，
       固定以 ?resources=native 加载纹理，修复 dpr=1 屏幕贴图降采样导致的模糊。
    4. 播放列表：只读当前正在运行用户的节点（记住的用户 → 系统登录名 → Steam 昵称 →
       唯一非空真实用户），换账号自动整份重读；列表为空时提示到 Wallpaper Engine 添加壁纸。
    5. 逐壁纸配置：用户配置项与视角 X/Y 按壁纸独立保存，修改实时渲染。
    6. 稳定性：写内核补丁前校验壁纸存在；清除背景保留损坏提示抑制 CSS；
       新增每 5 秒软写入与 60 秒旧会话清理，加快下次启动出图并抑制缓存堆积。
    7. 许可：以 MIT 发布，保留上游版权声明，新增 THIRD_PARTY_NOTICES.md。
    8. 构建：打包前清空 out/ 与 webview-dist/，避免已删除模块的旧产物被打进 VSIX。

# 安装包目录

- current/：当前构建；npm.cmd run package 和 Ctrl+Shift+B 均输出到此目录。
- archive/：旧版本及回退包。相同版本的不同构建使用描述后缀区分，包内版本不改变。
- 所有 VSIX 都由 Git 忽略，且 releases/ 整体不进入扩展包。归档包不会自动删除。
- 本次整理前的 1.0.2 保存在 archive/wallpaper-studio-1.0.2.before-folder-organization.vsix。

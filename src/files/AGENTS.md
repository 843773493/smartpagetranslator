# 目录作用

存放根目录文件树视图、文件节点模型和文件管理命令。

# 可以修改

- 根目录文件树的懒加载、缓存和排序逻辑
- 文件/文件夹的新建、打开、重命名、删除、复制路径、系统中显示等命令

# 不要修改

- 不要把递归扫描或全盘监听加入默认路径
- 不要在文件树中硬编码开发机绝对路径
- 不要绕过 VS Code `workspace.fs` 直接实现一套不兼容远程/虚拟文件系统的核心文件操作

# 约定

- 性能优先：只读取用户展开的一层目录，外部变化由刷新命令处理。
- 文件系统操作优先使用 VS Code 原生 API；只有原生 API 不满足时再考虑第三方包。
- Remote-SSH 下必须保留 `vscode-remote://` 的 scheme 和 authority，不要用 `vscode.Uri.file(uri.fsPath)` 重建远程资源。
- 复制、剪切、粘贴使用扩展内存中的文件操作剪贴板，不要覆盖系统文本剪贴板；必须支持本地、Remote-SSH、不同 SSH host 之间跨文件系统粘贴。
- 同一文件系统内复制/移动优先使用 `vscode.workspace.fs.copy/rename`；跨文件系统时使用 `readDirectory/readFile/writeFile/createDirectory` 递归复制，剪切必须先复制成功再删除源。
- 删除、重命名等破坏性操作必须给用户确认或错误提示。

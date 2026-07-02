# 目录作用

存放 Smart Page Translator 集成浏览器的命令、Webview 面板、消息协议和 HTML/网页预览适配逻辑。

# 可以修改

- 浏览器 Webview 面板 UI 和消息协议
- HTML 文件预览、网页 URL 打开、日志导出、元素选择等浏览器能力
- 与浏览器相关的 VS Code command 注册逻辑

# 不要修改

- 不要把浏览器逻辑反向塞回根目录文件树模块
- 不要依赖 VS Code 内部 `vs/*` 模块或 Electron 主进程私有 API
- 不要让日志、元素选择导出写入文件；这些浏览器工具的导出内容统一进入系统剪贴板

# 约定

- 扩展 API 可用能力优先；VS Code core BrowserView/CDP 私有能力只能作为参考，不能直接依赖。
- 本地 HTML 使用 Webview 文档直出并注入必要的工具条与桥接脚本，方便日志和元素选择。
- 远程网页通过 iframe 打开；遇到跨域、X-Frame-Options 或 CSP 限制时必须提示能力边界。
- 命令和 E2E 需要通过系统剪贴板验证导出结果，不要弹保存路径对话框。

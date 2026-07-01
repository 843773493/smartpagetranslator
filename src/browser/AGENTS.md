# 目录作用

存放 Smart Page Translator 集成浏览器的命令、Webview 面板、消息协议和 HTML/网页预览适配逻辑。

# 可以修改

- 浏览器 Webview 面板 UI 和消息协议
- HTML 文件预览、网页 URL 打开、截图、日志导出、元素选择等浏览器能力
- 与浏览器相关的 VS Code command 注册逻辑

# 不要修改

- 不要把浏览器逻辑反向塞回根目录文件树模块
- 不要依赖 VS Code 内部 `vs/*` 模块或 Electron 主进程私有 API
- 不要让日志、截图导出在用户未选择路径或未传入路径时静默写入未知位置

# 约定

- 扩展 API 可用能力优先；VS Code core BrowserView/CDP 私有能力只能作为参考，不能直接依赖。
- 本地 HTML 使用同源 `srcdoc` 渲染并注入必要的桥接脚本，方便日志、元素选择和截图。
- 远程网页通过 iframe 打开；遇到跨域、X-Frame-Options 或 CSP 限制时必须提示能力边界。
- 命令需要支持可选参数，便于 E2E 在不弹窗的情况下指定导出路径。

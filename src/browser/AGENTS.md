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
- 远程网页 URL 先由扩展本地 HTTP 代理拉取、移除 CSP/X-Frame-Options、重写相对资源，再把注入后的 HTML 作为 Webview 文档直出；只有无法预取的非 HTTP(S) URL 才保留 iframe fallback。不要让 iframe 直接指向目标 URL 或代理 URL，否则会重新遇到跨域、CSP、`chrome-error://chromewebdata` 导航限制。
- URL 页面脚本运行在 Webview 注入文档环境；需要目标地址时优先依赖注入的 `<base href="原始 URL">`、`document.baseURI` 或代理桥接设置，不要假设 `location.href` 等于原始网页 URL。
- URL 页面元素选择通过注入桥和 `smartPageTranslator.internal.selectBrowserElementBySelector` 验证；只断言选择结果时传 `{ copyToClipboard: false }`，避免把剪贴板稳定性混进 URL 代理测试。
- 命令和 E2E 需要通过系统剪贴板验证导出结果，不要弹保存路径对话框。

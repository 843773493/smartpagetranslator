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
- HTTP(S) URL 使用最薄的 `srcdoc` relay shell 承载内层代理 iframe；禁止把目标站 HTML 读取后塞进 `srcdoc`。顶层网页、静态子 iframe 和运行时创建的子 iframe 都必须由同一个代理 origin 返回并注入 bridge，以尽量保留站点内部的同源 frame 关系。
- URL 页面脚本运行在代理 HTTP 文档环境；需要原始目标地址时依赖注入的 `<base href="原始 URL">`、`document.baseURI` 或代理桥接设置。嵌套 frame 的 bridge 必须把日志和选择结果发给 Webview 顶层，并接收逐层传播的选择控制消息。
- JavaScript module URL 必须通过 Babel AST 定位 import/export specifier；禁止退回正则扫描 JavaScript 源码。Vite 注入 CSS 的 `__vite__css` 字符串需要继续走 CSS URL 重写。
- 每个代理页面 token 维护隔离的 Cookie 会话，并按 domain/path/secure/expiry 匹配；不得把目标站 `Set-Cookie` 原样暴露给 Webview。
- HTTP 代理必须同时处理 WebSocket upgrade，并把文本、二进制、关闭和错误事件双向转发到原始页面 host；Vite HMR 的连接失败属于测试失败，不能作为可忽略日志。
- URL 首文档加载失败必须渲染可见错误文档，页面运行时错误必须写入日志并显示错误提示，禁止静默白屏。
- URL 模式 CSP 需要兼容常见站点的动态脚本执行；工具栏挂载在 `<html>` 层，页面 `body` 整体下移并缩短视口，禁止用覆盖式 toolbar 遮挡 fixed 页面顶部，也不要包裹页面 body 子节点破坏直属 CSS selector。
- URL 页面元素选择通过注入桥和 `smartPageTranslator.internal.selectBrowserElementBySelector` 验证；只断言选择结果时传 `{ copyToClipboard: false }`，避免把剪贴板稳定性混进 URL 代理测试。
- 真实鼠标选择回归使用 `SPT_E2E_BROWSER_URL=<url>` 启用，必须验证业务 DOM、WebDriver 点击和关键字体实际加载；内部 selector 命令不能替代真实交互验收。
- 命令和 E2E 需要通过系统剪贴板验证导出结果，不要弹保存路径对话框。

# 集成浏览器参考实现调查

## 调查范围

参考仓库：`reference_repo/vscode`

VS Code 中相关实现分为两类：

- `extensions/simple-browser`：普通扩展可参考的 Webview + iframe 浏览器。
- `src/vs/**/browserView`：VS Code 内核级 Integrated Browser，依赖 Electron 主进程、BrowserView、IPC、内部 workbench service，普通扩展不能直接复制运行。

## Simple Browser 可迁移部分

关键文件：

- `reference_repo/vscode/extensions/simple-browser/package.json`
- `reference_repo/vscode/extensions/simple-browser/src/extension.ts`
- `reference_repo/vscode/extensions/simple-browser/src/simpleBrowserManager.ts`
- `reference_repo/vscode/extensions/simple-browser/src/simpleBrowserView.ts`
- `reference_repo/vscode/extensions/simple-browser/preview-src/index.ts`
- `reference_repo/vscode/extensions/simple-browser/media/main.css`

可借鉴点：

- 通过 `vscode.window.createWebviewPanel` 创建浏览器面板。
- Webview 内部用 iframe 承载页面。
- 工具栏提供 URL 输入、后退、前进、刷新、外部打开等动作。
- 通过 `vscode.workspace.getConfiguration(...)` 读取配置。
- 通过 Webview state 和 message 通道在扩展侧、前端侧传递状态。

当前项目沿用 Webview 面板和消息通道，但 HTTP(S) URL 不再直接放入 iframe。扩展宿主中的本地代理获取 HTML、移除页面 CSP、重写脚本和静态资源 URL，再把文档注入 Webview；这样元素选择器可以直接访问页面 DOM。

## VS Code Integrated Browser 只能借鉴的部分

关键文件：

- `reference_repo/vscode/src/vs/platform/browserView/common/browserView.ts`
- `reference_repo/vscode/src/vs/platform/browserView/common/browserViewUri.ts`
- `reference_repo/vscode/src/vs/platform/browserView/electron-main/browserView.ts`
- `reference_repo/vscode/src/vs/platform/browserView/electron-main/browserViewMainService.ts`
- `reference_repo/vscode/src/vs/platform/browserView/electron-browser/preload-browserView.ts`
- `reference_repo/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserView.contribution.ts`
- `reference_repo/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts`
- `reference_repo/vscode/src/vs/workbench/contrib/browserView/electron-browser/features/*`
- `reference_repo/vscode/src/vs/workbench/contrib/browserView/electron-browser/tools/screenshotBrowserTool.ts`

不能直接移植的原因：

- 使用 Electron `WebContentsView`、`webContents.capturePage()`、`webContents.toggleDevTools()` 等主进程能力。
- 通过 VS Code 内部 IPC channel 调用 `IBrowserViewService`、`IBrowserViewMainService`。
- 菜单、editor resolver、toolbar、chat tools 都依赖 VS Code 内部 `vs/*` 模块。
- 截图、元素选择和 DevTools 依赖 preload、CDP、Playwright service 等内部实现。

可借鉴点：

- 命令分层：打开页面、打开本地文件、截图、区域截图、日志、DevTools 分别注册。
- 日志模型：浏览器侧收集 console 记录，扩展侧提供导出/使用入口。
- 元素选择：页面内注入 picker，返回 selector、文本、坐标等结构化信息。
- 截图接口：视口截图和区域截图使用同一套 capture 请求，只是带不同 region。
- 配置入口：全部通过 VS Code configuration contribution 落地。

## 当前项目落地方案

实现文件：

- `src/browser/integratedBrowserManager.ts`
- `src/browser/AGENTS.md`
- `src/files/rootFileCommands.ts`
- `src/files/rootFileItem.ts`
- `package.json`
- `test/e2e/specs/05-root-files.e2e.mjs`

用户入口：

- 普通文件资源管理器右键 HTML 文件：`预览 HTML`，由 `contributes.menus["explorer/context"]` 提供。
- 当前编辑器右键或编辑器标题右键 HTML：`预览 HTML`。
- 自定义根目录文件树右键 HTML：`预览 HTML`。
- VS Code `Open With...`：`Smart Page Translator HTML 预览`，由 `contributes.customEditors` 提供。
- 命令面板：`集成浏览器: 打开网页` 等浏览器命令。

能力：

- 本地 `.html/.htm` 预览。
- HTTP(S) URL 通过本地代理和 HTML 注入浏览，其他 URL 使用兼容回退路径。
- console 日志收集和 JSON 导出。
- 元素选择，返回 selector、文本和坐标。
- 尝试打开 Webview DevTools，旧版本 VS Code 退回窗口 DevTools。
- 配置项落在 `package.json contributes.configuration` 和 `vscode.workspace.getConfiguration('smartPageTranslator.browser')`。

## 已知边界

- 代理按页面 token 维护隔离的 Cookie 会话，支持常见 domain/path/secure/expiry 规则；OAuth、验证码和第三方 Cookie 流程仍不属于已验证范围。
- JavaScript 和 CSS 资源重写用于常见模块与静态资源，WebSocket upgrade 通过同一页面 token 双向转发；Service Worker、import map 和复杂流式响应仍可能需要站点级适配。
- URL Webview CSP 允许常见站点使用的动态脚本执行；浏览器工具栏占用独立顶部区域，页面视口从工具栏下方开始，fixed 页面内容不会再被遮挡。
- Remote-SSH 分支通过 `vscode.env.asExternalUri()` 暴露代理端口，尚缺真实 Windows + Remote-SSH 的自动化环境验证。
- DevTools 命令依赖 VS Code 提供的 Webview DevTools command，不等同于 core BrowserView 的 `webContents.toggleDevTools()`。

## 测试覆盖

E2E fixture：

- `test-fixtures/workspace/html-preview.html`

E2E 覆盖：

- 校验 HTML 预览命令、Explorer context、editor context、editor title context 和 Custom Editor contribution 存在。
- 当前未直接用 `vscode.openWith` 做自动化打开验证：WDIO 的 `executeWorkbench` 路径会触发测试窗口卸载，已在 E2E 中保留 TODO，后续改用稳定 UI 自动化路径补充。
- 通过根目录文件树预览命令打开 HTML 并验证渲染。
- 验证本地 HTML 的元素选择和日志导出。
- 验证 URL 命令、首屏客户端跳转、Cookie 会话、嵌套 ES Module、Vite 内联 module、页面 fetch、双向 WebSocket、CSS `@import`、Vite 注入 CSS、字体、图片资源、可见错误页和元素选择。
- 设置 `SPT_E2E_BROWSER_URL` 时，在独立 VS Code 会话中对指定真实 URL 验证页面渲染、字体加载和 WebDriver 真实鼠标选择。

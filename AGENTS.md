# 通用指令

## 开发规范

### 沟通与交付

1. 用中文交流，代码注释也用中文，专业名词除外
2. 非用户主动要求，不要写总结文档

### 实现方式

1. 初次实现功能时减少 try except，以实现核心功能为主
2. 每当遇到你对代码不自信的地方时，在代码中添加TODO注释
3. 每当你或者用户让你跳过某些重要实现时，在代码中添加TODO注释
4. 每当你执行兼容性写法时，在代码中添加TODO注释
5. 尽量避免使用any类型，除非遇到泛型等复杂情况，可以保留any
6. 能用第三方库就添加并使用第三方库，不要重复造轮子
7. 类：禁止原型混入/变异。优先继承/组合

### 依赖与配置

1. 不要在代码中给环境变量添加硬编码参数，
2. 如果根目录下存在.venv目录，则使用.venv\Scripts\python.exe的python解释器和pytest而不是全局python
3. 懒加载的包单独放runtime模块里

### 运行与质量

1. 每次编写代码文件都要通过静态分析

### 代码组织

1. package.json中指令过长，则写入scrips的.mjs脚本中
2. 仓库中js代码统一使用 ESM (ES Modules)，使用 `import`/`export` 语法，避免 CommonJS

### 提交与目录规范

1. git提交：常规风格、简洁、分组。
2. 创建的每个子目录必须包含 AGENTS.md 文件，包含'目录作用'、'可以修改'、'不要修改'、'约定'四部分指令。

### 失败处理

1. 程序永远不要静默失败。

## 项目专属

### 配置

1. 当前已落地配置来源是 `package.json contributes.configuration` 和 `vscode.workspace.getConfiguration('smartPageTranslator')`；不要在未实现配置改造时新增 `config.jsonc` 体系。
2. `config.jsonc / config.example.jsonc`、`config_obs.jsonc`、配置热加载属于未来目标；实现前必须先说明方案、补测试，并在未完成处加 TODO。
3. Notes 设置页查询优先直接使用与 `package.json` 中配置项一致的 `smartPageTranslator.notes` 命名空间。
4. Python 相关仓库脚本若将来引入项目级 Python 环境，优先使用 uv；当前扩展的 `runPytest` 命令实际发送 `pytest "<relativePath>"`，改成 uv 需要同步更新实现、README 和 E2E。

### 项目范围

1. 配置热加载是待实现目标，不要假设已经完成。

### 自动化 E2E 测试

1. 本项目已经全面改用 `vscode-auto-test` 模板迁移来的 WebdriverIO + `wdio-vscode-service` 测试体系；不要再新增或恢复 `.vscode-test.mjs`、`src/test/**`、`vscode-test`、`@vscode/test-cli`、`@vscode/test-electron` 作为直接测试入口。
2. 默认测试命令是：

```bash
npm install
npm run compile
npm test
```

3. `npm test` 等价于 `npm run e2e`。常用命令：

```bash
npm run e2e
npm run e2e:trace
npm run e2e:debug
npm run artifacts:latest
```

4. E2E 关键文件：
   - `wdio.conf.mjs`：基础 WDIO + VS Code 桌面测试配置。
   - `wdio.trace.conf.mjs`：trace 模式，额外接入 `@wdio/devtools-service`。
   - `wdio.debug.conf.mjs`：live debug 模式。
   - `scripts/run-e2e.mjs`：统一编译并启动 WDIO。
   - `test/e2e/specs/*.e2e.mjs`：按工作流拆分的 E2E 场景。
   - `test/e2e/support/extension-contract.mjs`：E2E 使用的扩展 ID、命令 ID、view ID 契约。
   - `test/e2e/support/diagnostics.mjs`：UI 快照、HTML、截图、命令日志、失败诊断。
   - `test/e2e/support/harness.mjs`：Smart Page Translator 专用测试 helper。
   - `test-fixtures/workspace`：E2E 固定样例工作区。
5. 每次 E2E 运行都会复制 `test-fixtures/workspace` 到 `e2e/artifacts/<run-id>/workspace`。测试只能修改 artifact workspace，不要让测试写回固定 fixture。
6. 每次运行的排障材料在 `e2e/artifacts/<run-id>/`：
   - `ui-reports/*.md`：优先给文本 agent/人工看 UI 状态。
   - `ui-snapshots/*.json`：结构化 DOM、样式和坐标。
   - `html/*.html`：当前 frame HTML。
   - `screenshots/*.png`：当前画面截图。
   - `commands.jsonl`：WebDriver 命令流水。
   - `tests.jsonl`：测试结果流水。
   - `vscode-storage/`：隔离的 VS Code 用户数据和日志。
   - `wdio-trace-output/trace-*.zip`：仅 `npm run e2e:trace` 生成，可用 `npx playwright show-trace <trace.zip>` 查看。
7. 如果修改 `package.json` 里的命令、view/container id 或扩展 ID，必须同步更新 `test/e2e/support/extension-contract.mjs`。
8. E2E 依赖以下未贡献到 UI 的内部命令：
   - `smartPageTranslator.internal.useDeterministicTranslator`：翻译 E2E 使用，避免依赖真实 Bing 网络结果。
   - `smartPageTranslator.internal.getLastAstOutline`：AST E2E 使用，读取最近一次 outline，避免 headless 剪贴板读取不稳定。
   - `smartPageTranslator.internal.getRootFileQuickPathStorage`：根目录文件树 E2E 使用，确认快捷路径写入工作区状态而不是全局状态。
   - `smartPageTranslator.internal.getRootFileItemCommandState`：根目录文件树 E2E 使用，只读确认文件节点通过 VS Code API 命令打开，不会生成易失效的自定义命令代理。
   - `smartPageTranslator.internal.getBrowserState`：集成浏览器 E2E 使用，读取 Webview 管理器状态，避免不同 VS Code 版本的 Webview frame DOM 差异导致断言不稳定。
   - `smartPageTranslator.internal.closeStandaloneBrowser`：集成浏览器 E2E 清理使用，关闭独立浏览器 Webview，避免后续 Webview 用例复用错误 frame。
   - `smartPageTranslator.internal.getSelectedBrowserElementContext`：HTML 预览 E2E 使用，只读获取当前元素完整上下文，避免大文本剪贴板写入干扰 VS Code 测试宿主。
   - `smartPageTranslator.internal.setBrowserInspectMode`：集成浏览器 E2E 使用，开启或关闭页面元素选择模式。
   - `smartPageTranslator.internal.selectBrowserElementBySelector`：集成浏览器 E2E 使用，通过注入桥按 CSS selector 触发元素选择，避免 WebDriver 穿透 VS Code Webview iframe 的不稳定性；URL 浏览器只验证选择状态时可传 `{ copyToClipboard: false }`，剪贴板导出由 HTML 预览用例单独覆盖。
   这些命令是测试接缝；删除或改名必须同步更新 `test/e2e/support/extension-contract.mjs` 和相关 spec。
9. 如果修改 UI、Notes、翻译、AST、终端、根目录文件树相关工作流，必须补充或更新对应 `test/e2e/specs/*.e2e.mjs`，并运行 `npm test`。
10. E2E 中需要稳定验证 UI 时优先调用 `collectUiSnapshot(label)` 保存观察材料；难以稳定点击的 VS Code 状态优先通过 `browser.executeWorkbench()` 调用 VS Code API 断言。
11. 不要提交 `node_modules/`、`out/`、`.tmp/`、`.wdio-vscode-cache/`、`.vscode-test/`、`e2e/artifacts/`。

## Agent 协作

### 协作方式

1. 本项目全程由vibe coding生成，agent上下文有限，智力有限，所以一旦遇到不符合开发规范的地方要积极举手告知用户

### 环境配置

1. 开发任务中遇到环境配置的问题，优先跳过然后实现其它部分，最后询问用户来配置，不要瞎改环境配置。
2. 安装环境时不要考虑手动编译，充分搜索相关预编译包，如何还是找不到，通知用户。

## 额外

### 用户根据agent反馈手动添加的尚未整理的额外指令

1. 模板示例，整理AGENTS.md时保留这行
2. Python 相关环境若引入项目级工具，优先使用 uv；当前 VS Code 扩展测试不依赖 Python 环境。
3. 开启代理：export http_proxy=http://127.0.0.1:10808 https_proxy=http://127.0.0.1:10808
4. 关闭代理 unset http_proxy https_proxy

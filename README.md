# Smart Page Translator

VS Code 智能页面翻译扩展，提供一键代码翻译与代码结构上下文提取功能。

## 参考项目

本项目在功能设计和 VS Code 扩展交互上参考了 [`vscode-notes`](reference_repo/vscode-notes/README.md) 的组织方式与使用体验，结合本项目的代码翻译、脚本运行和结构提取需求进行了适配。

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🌐 一键文档翻译 | 将整个文件从英文翻译为中文，保留原始格式 |
| ⚡ 用 tsx 运行 | 右键快速运行 TS/JS 文件，自动使用 npx tsx |
| 🧪 pytest 运行 | 右键快速运行 Python 测试文件，自动执行 pytest 文件名 |
| 📄 代码结构大纲提取 | 右键一键生成 JS/TS/Python 文件的代码结构上下文并复制到剪贴板 |
| 🗂️ 根目录文件树 | 在资源管理器中浏览电脑根目录，支持常用文件管理操作 |
| 💬 实时进度提示 | 完整的操作状态反馈与错误提示 |
| 📝 支持语言 | JavaScript / TypeScript / Python 与常规文本文件 |


## 🚀 安装使用

### 1. 安装扩展
下载 `.vsix` 安装包后，在 VS Code 扩展面板点击 `...` -> 选择 `Install from VSIX...`

### 2. 文件翻译
- 打开目标文件
- 点击编辑器标题栏右侧的 **Translate to Chinese** 按钮
- 翻译完成后结果会在新标签页打开

### 3. 用 tsx 运行
- 在 `.ts` `.tsx` `.js` `.jsx` `.mts` `.cts` `.mjs` `.cjs` 文件上右键
- 选择 **用 tsx 运行**
- 会在工作区根目录终端中执行 `npx tsx <文件路径>`

### 4. pytest 运行
- 在 Python 文件上右键
- 选择 **Run** -> **pytest运行**
- 会在工作区根目录终端中执行 `pytest <文件路径>`

### 5. 代码结构提取
- 在支持的代码文件上点击鼠标右键
- 选择 **复制为 -> 复制代码结构上下文**
- 执行完成后代码结构大纲将自动复制到剪贴板

### 6. 根目录文件树
- 打开 VS Code 资源管理器
- 展开 **根目录文件树**
- 右键文件或文件夹，可执行打开、新建、重命名、删除、复制路径、在系统中显示和刷新

> ✅ 支持文件类型: `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.py`

> ✅ 支持运行文件类型: `.ts` `.tsx` `.js` `.jsx` `.mts` `.cts` `.mjs` `.cjs`


## 🔧 配置选项

| 配置项 | 默认值 | 描述 |
|--------|--------|------|
| `smartPageTranslator.concurrency` | 20 | 最大并行翻译任务数 |
| `smartPageTranslator.maxChunk` | 1000 | 翻译分段最大字符长度 |


## 🛠️ 开发构建

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 打包 VSIX 安装包
npm run package
```

启动调试：打开项目后按 `F5`，选择 `Debug Smart Page Translator Extension`。这个默认配置兼容 Remote-SSH；只有在本地非远程仓库调试 fixture 时才选择 `Debug Smart Page Translator Extension (Local Isolated Fixture)`。命令行可用 `npm run start` 启动隔离 Extension Development Host。

## 自动化测试

```bash
# 默认测试：WebdriverIO + VS Code 桌面 E2E
npm test

# 等价命令
npm run e2e

# 生成 trace 和增强诊断
npm run e2e:trace

# 查看最近一次 E2E 运行产物
npm run artifacts:latest
```

E2E 会在 `e2e/artifacts/<run-id>/` 下保存本次运行的 VS Code workspace 副本、命令日志、UI HTML、截图、结构化快照和可读的 `ui-reports/*.md`。测试启动前会把 `test-fixtures/workspace` 复制到 artifact workspace，Notes 新建/重命名/删除不会污染仓库样例文件。Linux 无桌面环境下由 WDIO 配置自动处理 Xvfb。

如果需要使用本机 VS Code：

```bash
VSCODE_BINARY="$(which code)" npm run e2e
```


## 📝 许可证
MIT License

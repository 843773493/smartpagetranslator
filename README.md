# Smart Page Translator

VS Code 智能页面翻译扩展，提供一键代码翻译与代码结构上下文提取功能。

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🌐 一键文档翻译 | 将整个文件从英文翻译为中文，保留原始格式 |
| 📄 代码结构大纲提取 | 右键一键生成 JS/TS/Python 文件的代码结构上下文并复制到剪贴板 |
| ⚡ 并行翻译优化 | 支持大文件分段并行翻译，性能优异 |
| 💬 实时进度提示 | 完整的操作状态反馈与错误提示 |
| 📝 支持语言 | JavaScript / TypeScript / Python 与常规文本文件 |


## 🚀 安装使用

### 1. 安装扩展
下载 `.vsix` 安装包后，在 VS Code 扩展面板点击 `...` -> 选择 `Install from VSIX...`

### 2. 文件翻译
- 打开目标文件
- 点击编辑器标题栏右侧的 **Translate to Chinese** 按钮
- 翻译完成后结果会在新标签页打开

### 3. 代码结构提取
- 在支持的代码文件上点击鼠标右键
- 选择 **复制为 -> 复制代码结构上下文**
- 执行完成后代码结构大纲将自动复制到剪贴板

> ✅ 支持文件类型: `.js` `.jsx` `.mjs` `.cjs` `.ts` `.tsx` `.py`


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

启动调试：打开项目后按 `F5` 启动插件调试会话


## 📝 许可证
MIT License
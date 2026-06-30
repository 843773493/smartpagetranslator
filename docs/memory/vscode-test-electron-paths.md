# VS Code 测试宿主路径经验

> 历史归档：本文记录旧 `@vscode/test-electron` 测试入口的路径经验，不代表当前测试入口。当前测试体系以根 `AGENTS.md` 和 `npm test` 的 WDIO E2E 为准；不要按本文恢复 `.vscode-test.mjs`、`src/test/**` 或 `vscode-test`。

- `src/test/runTest.ts` 是编译后执行，`__dirname` 会落到 `out/src/test`，所以 `path.resolve(__dirname, '../..')` 只会回到 `out`，不是仓库根目录。
- `extensionDevelopmentPath` 必须指向包含 `package.json` 的扩展根目录，否则 `@vscode/test-electron` 能启动但不会把本地扩展挂进 `vscode.extensions.all`。
- 排查 `getExtension(...) === null` 时，优先先打印 `extensionDevelopmentPath` 和 `package.json` 是否存在，再查命令注册或激活逻辑。
- 对于 `out/src/test/runTest.js`，正确的仓库根目录通常需要 `path.resolve(__dirname, '../../..')`。

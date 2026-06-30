# 目录作用

存放可提交的 VS Code 调试和任务配置。

## 可以修改

- `launch.json`
- `tasks.json`

## 不要修改

- 不要提交个人 `settings.json`、`keybindings.json` 或本机路径配置。
- 不要把临时 user-data、extensions、缓存目录放进 `.vscode`。

## 约定

- 默认 F5 调试配置必须兼容 Remote-SSH，不要使用空的 `--extensions-dir` 打开 `vscode-remote://` workspace。
- `Local Isolated Fixture` 配置只用于本地非 Remote-SSH 仓库；它会使用隔离 user-data/extensions 并打开 `test-fixtures/workspace`。
- 调试前使用 `npm run compile` 编译扩展。

# 目录作用

存放基于 WebdriverIO 和 wdio-vscode-service 的 VS Code 扩展 E2E 测试。

# 可以修改

- `specs/` 下的测试用例
- `support/` 下的测试契约、诊断和配置辅助代码

# 不要修改

- 不要在测试中依赖真实外部翻译网络结果
- 不要把运行产物写入仓库固定 fixture

# 约定

- E2E 运行时使用 `e2e/artifacts/<run-id>/workspace` 的 workspace 副本
- 失败诊断优先查看 `e2e/artifacts/<run-id>/ui-reports`

# 目录作用

存放 Smart Page Translator 的可执行 E2E 场景。

# 可以修改

- 新增或调整 `.e2e.mjs` 测试规格

# 不要修改

- 不要在规格中硬编码开发机绝对路径
- 不要让测试依赖真实第三方翻译服务稳定性

# 约定

- 路径从 `WDIO_WORKSPACE_PATH` 和 `WDIO_NOTES_PATH` 读取
- 测试断言以 VS Code API 状态和文件系统结果为主

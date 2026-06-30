# 目录作用

存放 E2E 测试契约、诊断采集和 WDIO 配置辅助函数。

# 可以修改

- 命令 ID 契约
- UI 快照和 artifact 采集逻辑
- WDIO debug/trace 配置辅助函数

# 不要修改

- 不要把业务实现写入 support
- 不要在 support 中创建会污染仓库工作区的文件

# 约定

- support 代码使用 ESM
- 诊断数据统一写入 `WDIO_ARTIFACTS_DIR`

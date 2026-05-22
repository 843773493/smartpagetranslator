# @vscode/test-electron 扩展加载异常排查记录

## 背景

当前目标是用 `@vscode/test-electron` 做 VS Code 扩展集成测试，验证插件能在测试宿主中加载并注册命令。

测试命令已经可以启动并退出，说明测试框架本身是可工作的；但扩展在测试宿主里始终没有表现为已加载/已激活，最终导致命令查找失败。

## 已验证的事实

1. `npm test` 可以正常启动 `@vscode/test-electron`，测试进程不会因为“没手动关窗口”而卡住。
2. `src/extension.ts` 中主命令注册逻辑存在，且注册顺序是先注册主命令，再初始化 notes 相关逻辑。
3. `package.json` 中的 `main` 为 `./out/extension.js`，与 `npm run compile` 的输出一致。
4. `activationEvents` 已包含：
   - `onStartupFinished`
   - `onView:smart-page-translator-notes`
   - `onCommand:smartPageTranslator.translate`
   - `onCommand:smartPageTranslator.extractAstOutline`
   - `onCommand:smartPageTranslator.runWithTsx`
   - `onCommand:smartPageTranslator.runPytest`
5. 测试里尝试过多种 smoke test 方式：
   - 直接查 `vscode.extensions.getExtension(...)`
   - 遍历 `vscode.extensions.all`
   - 先 `activate()` 再查命令
   - 直接 `executeCommand('smartPageTranslator.translate')`

但都没有让命令在测试宿主里稳定可见。

6. 即便把 `src/test/runTest.ts` 恢复成最小官方启动形式、去掉临时 workspace，结果也没有变化，说明 `launchArgs` 不是根因。

7. 额外检查了仓库里和扩展加载相关的配置，没有找到比当前怀疑点更强的新线索；`publisher`、`name`、`main` 都自洽，问题仍然表现为开发扩展未进入测试宿主的可见扩展列表。

8. 最新复测还确认了：测试文件本身已被 runner 执行（`extension.test.js loaded` 会出现），但 `getExtension('843773493.smart-page-translator')` 仍然返回 `null`，所以当前失败已经不是“测试没跑到”，而是“开发扩展根本没被宿主识别”。

## 当前失败现象

最新一次测试的失败点是：

```text
Error: command 'smartPageTranslator.translate' not found
```

或者在更早的版本里表现为：

```text
AssertionError: Extension should be discoverable
```

同时，测试宿主打印的可见扩展列表中没有看到这个扩展进入 `vscode.extensions.all`。

## 当前测试入口状态

### `src/test/runTest.ts`

当前测试入口已收敛到最小启动形式：

- `extensionDevelopmentPath = path.resolve(__dirname, '../..')`
- `extensionTestsPath = path.resolve(__dirname, './suite')`
- `runTests({ extensionDevelopmentPath, extensionTestsPath })`

之前尝试过的额外 `launchArgs`、临时 workspace、`--disable-extensions` 等参数，已经多次验证过，并不能解决“扩展未可见”的问题。

### `src/test/suite/extension.test.ts`

目前 smoke test 的目标很简单：

- 先尽量触发扩展加载或激活
- 再检查主命令是否已经注册

但测试宿主里依然没有稳定暴露出扩展对象，导致命令查找失败。

## 最可能的根因方向

### 方向 1：测试宿主没有把本地扩展作为可见扩展加载进来

这是目前最像根因的方向，因为 `vscode.extensions.all` 里一直看不到该扩展。

需要检查：

- `extensionDevelopmentPath` 是否确实指向仓库根目录
- 测试宿主是否意外使用了错误的工作区/扩展上下文
- 本地扩展是否需要更明确的测试启动参数或宿主配置才会进入可见扩展列表

### 方向 2：扩展激活时机与测试断言时机不一致

虽然已经尝试过显式 `activate()`，但如果扩展对象本身不可见，`activate()` 也无法真正执行。

这说明问题更偏向加载阶段，而不是命令注册阶段。

### 方向 3：测试入口和官方样例仍存在细微差异

官方 `vscode-test` sample 的模式是：

- `runTests({ extensionDevelopmentPath, extensionTestsPath })`
- `launchArgs` 只在需要工作区时传 workspace 路径
- 测试文件使用 Mocha 的 `suite/test`

当前仓库已经接近这个结构，但扩展在宿主里仍不可见，因此仍需要进一步对齐启动链路。

## 已排除的方向

1. 不是 `main` 指向错误。
2. 不是 `compile` 没产出 `out/extension.js`。
3. 不是主命令注册代码不存在。
4. 不是测试进程卡住不退出。
5. 不是单纯的 Mocha 写法错误。

## 建议下一步检查项

1. 直接核查测试宿主里 `extensionDevelopmentPath` 的实际值与仓库根目录是否完全一致。
2. 对照官方 sample，再确认是否需要显式 workspace 路径，或者在测试里使用一个最小 fixture workspace。
3. 如果宿主仍看不到扩展，进一步检查当前 VS Code 测试版本下是否有额外的本地扩展加载限制。
4. 如果能让扩展对象进入 `vscode.extensions.all`，再回到命令注册断言。

## 可交接给其他 agent 的一句话摘要

`@vscode/test-electron` 的测试流程本身能跑通并退出，但当前测试宿主里始终看不到 `smart-page-translator` 扩展进入 `vscode.extensions.all`，因此命令注册断言失败；优先排查 `extensionDevelopmentPath` / workspace 启动链路与官方 sample 的细微差异。
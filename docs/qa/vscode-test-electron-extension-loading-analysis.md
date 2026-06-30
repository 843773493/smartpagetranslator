# `@vscode/test-electron` 扩展加载异常交接分析

> 历史归档：本文记录旧 `@vscode/test-electron` 测试入口的问题排查，不代表当前测试入口。当前测试体系以根 `AGENTS.md` 和 `npm test` 的 WDIO E2E 为准；不要按本文恢复 `.vscode-test.mjs`、`src/test/**` 或 `vscode-test`。

## 0. 一句话结论

当前问题的核心不应继续优先排查命令注册或激活事件，而应先证明：

> VS Code 测试宿主是否真的把当前仓库根目录作为 `extensionDevelopmentPath` 对应的开发扩展加载进来了。

因为当前最关键的现象是：

- `vscode.extensions.all` 里看不到 `smart-page-translator`
- 因此 `vscode.extensions.getExtension(...)` 找不到扩展
- 因此 `activate()` 无法执行
- 因此 `smartPageTranslator.translate` 命令不存在

所以：

> `command 'smartPageTranslator.translate' not found` 很可能是结果，不是根因。

---

## 1. 当前已知背景

目标：使用 `@vscode/test-electron` 做 VS Code 扩展集成测试，验证插件能在测试宿主中加载并注册命令。

当前状态：

- `npm test` 能启动并退出
- 测试框架本身可工作
- `src/extension.ts` 里主命令注册逻辑存在
- `package.json` 中 `main` 是 `./out/extension.js`
- `npm run compile` 能产出对应文件
- `activationEvents` 已包含：
  - `onStartupFinished`
  - `onView:smart-page-translator-notes`
  - `onCommand:smartPageTranslator.translate`
  - `onCommand:smartPageTranslator.extractAstOutline`
  - `onCommand:smartPageTranslator.runWithTsx`
  - `onCommand:smartPageTranslator.runPytest`

当前失败现象：

```text
Error: command 'smartPageTranslator.translate' not found
```

或者早期版本：

```text
AssertionError: Extension should be discoverable
```

关键观察：

```text
vscode.extensions.all 中没有看到该扩展。
```

最近一次测试还补充确认了：

```text
[test] visible extensions: ...
```

输出里仍然没有 `843773493.smart-page-translator`，而且命令断言还是失败。

另外，`@vscode/test-electron` 在获取 VS Code 版本时曾短暂出现网络超时，但随后自动回退到已安装版本 1.121.0，并继续执行测试；这不是最终失败根因。

---

## 2. 当前最可能根因排序

### 2.1 扩展根目录没有被测试宿主作为开发扩展加载

这是最高优先级方向。

`@vscode/test-electron` 的核心模型是：

```ts
runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
});
```

其中：

- `extensionDevelopmentPath` 必须指向扩展根目录
- 这个目录下必须直接有扩展的 `package.json`
- 该 `package.json` 必须是 VS Code 可识别的扩展 manifest

如果 `extensionDevelopmentPath` 指错了，例如指向：

- `out/`
- `out/test/`
- monorepo 根目录而不是扩展 package 根目录
- 编译产物目录
- 不含扩展 `package.json` 的目录

那么测试宿主可以正常启动，但开发扩展不会进入 `vscode.extensions.all`。

---

### 2.2 扩展 ID 查错

VS Code API 中 `vscode.extensions.getExtension(...)` 需要的是完整扩展 ID：

```text
publisher.name
```

而不是单独的 `name`。

例如，如果 `package.json` 是：

```json
{
  "publisher": "caleb",
  "name": "smart-page-translator"
}
```

那么应该查：

```ts
vscode.extensions.getExtension('caleb.smart-page-translator');
```

而不是：

```ts
vscode.extensions.getExtension('smart-page-translator');
```

不过，当前记录里提到“遍历 `vscode.extensions.all` 也看不到扩展”，所以扩展 ID 查错不是唯一可能，但仍需要优先确认。

---

### 2.3 `engines.vscode` 与测试用 VS Code 版本不兼容

如果 `package.json` 中写了：

```json
"engines": {
  "vscode": "^1.xx.x"
}
```

而 `@vscode/test-electron` 实际下载或缓存的 VS Code 版本不满足这个范围，扩展可能不会被正常加载。

接手 agent 应检查：

```bash
cat package.json | jq '.engines'
```

并确认测试下载的 VS Code 版本。

可尝试：

```bash
rm -rf .vscode-test
npm test
```

重新下载测试 VS Code，排除缓存污染。

---

### 2.4 `extensionTestsPath` 与官方 sample 存在细微差异

当前记录中的入口是：

```ts
extensionDevelopmentPath = path.resolve(__dirname, '../..')
extensionTestsPath = path.resolve(__dirname, './suite')
runTests({ extensionDevelopmentPath, extensionTestsPath })
```

官方 sample 通常是：

```ts
const extensionDevelopmentPath = path.resolve(__dirname, '../../');
const extensionTestsPath = path.resolve(__dirname, './suite/index');

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
});
```

如果 `./suite` 当前能跑，说明 Node 可能解析到了 `suite/index.js`，但为了减少不确定性，建议先完全对齐官方 sample：

```ts
const extensionTestsPath = path.resolve(__dirname, './suite/index');
```

### 2.6 自造的 temp runner 不能直接当作有效对照

这轮在 `temp/exp-01-baseline` 里做的最小原型进一步说明了一点：

- `@vscode/test-electron` 对 `extensionTestsPath` 所指向的 runner 有固定约定
- 自己随便拼一个本地 runner 路径，可能直接报 “does not point to a valid extension test runner”
- 所以 temp 实验只能用来验证官方约定的边界，不能拿它去替代主仓库正式测试入口的对照

这意味着当前真正有价值的排查目标，仍然是主仓库正式的 `src/test/runTest.ts` / `src/test/suite.ts` 链路，以及它和官方 sample 的差异。

### 2.7 去掉 workspace 之后结果没有变化

最近一次把 `src/test/runTest.ts` 恢复成最小官方启动后，测试结果仍然是：

- `vscode.extensions.all` 看不到 `843773493.smart-page-translator`
- `vscode.extensions.getExtension('843773493.smart-page-translator')` 返回空
- 命令断言继续失败

所以当前可以明确排除：`launchArgs` 里的临时 workspace 不是根因。

### 2.8 额外配置项没有发现新的可疑点

这轮再次检查仓库内和加载相关的配置后，未发现比现有怀疑点更强的新线索：

- `package.json` 的 `publisher`、`name`、`main` 都是自洽的
- 没有发现会显式禁用扩展加载的仓库级配置
- `extensionKind` 目前为 `ui` / `workspace`，但这和测试宿主里完全看不到扩展对象不是同一层问题

因此，当前最稳妥的判断仍然是：问题在测试宿主没有把本地开发扩展识别进 `vscode.extensions.all`，而不是测试入口代码里某个额外参数。

### 2.9 最新复测把“未激活”也排除了

最近一次测试中：

- `extension.test.js loaded` 会打印，说明测试文件确实被 runner 收集并执行
- `vscode.extensions.getExtension('843773493.smart-page-translator')` 仍然是 `null`
- 因为 `getExtension` 就是空，所以 `activate()` 根本没有机会执行

因此当前问题已经可以明确为：开发扩展没有被测试宿主挂进可见扩展列表，且不是测试文件收集、不是命令注册、也不是激活函数内部逻辑导致的。

---

### 2.5 启动参数中误用了 `--disable-extensions`

如果传入：

```ts
launchArgs: ['--disable-extensions']
```

需要注意：它可能影响扩展加载判断。

虽然理论上开发扩展通常仍可通过 `--extensionDevelopmentPath` 加载，但实际排查中应避免这个变量干扰。

建议当前最小启动保持：

```ts
await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
});
```

不要加：

```text
--disable-extensions
--disable-workspace-trust
--user-data-dir
--extensions-dir
```

除非某一步明确需要。

> 备注：当前仓库已经把测试入口回退到最小形态，并且也试过加/不加工作区路径；问题仍然存在，说明“参数太多”不是唯一根因。

---

## 3. 社区相似案例

### 3.1 `vscode-test` issue #187：扩展安装/传入后，测试宿主里看不到扩展

相似点：

- VS Code 测试宿主能启动
- 期望扩展没有出现在测试宿主中
- 扩展扫描路径/加载路径存在异常迹象

相关链接：

```text
https://github.com/microsoft/vscode-test/issues/187
```

这个案例中，症状接近“测试宿主没有看到扩展”，但具体根因可能与传入参数有关。

---

### 3.2 VS Code issue #252812：`@vscode/test-electron` 集成测试中 extension init 没有运行

相似点：

- `@vscode/test-electron` 能启动测试
- 但 `extension.ts` 的初始化逻辑没有执行
- 与“扩展没有激活/没有加载”属于同一类症状

相关链接：

```text
https://github.com/microsoft/vscode/issues/252812
```

该 issue 公开页面里不一定有明确结论，但可作为相似案例参考。

---

## 4. 最近一次测试的最终状态

最新一次 `npm test` 的结果：

- `vscode.extensions.all` 里依旧看不到 `smart-page-translator`
- `smartPageTranslator.translate` 仍然找不到
- 测试宿主启动成功并退出
- 扩展主逻辑没有出现明显启动报错日志

这进一步支持：根因仍然在“扩展没有作为开发扩展被测试宿主挂进来”，而不是命令注册或 Mocha 写法。

## 5. 这轮继续排查后的新增事实

最近一次复测做了两件事：

1. 在测试里打印了 `vscode.extensions.all`
2. 只保留最小 smoke test，不再做额外工作区或启动参数干扰

结果仍然一致：

- `vscode.extensions.all` 中没有 `843773493.smart-page-translator`
- 命令断言继续失败
- `out/extension.js` 存在且内容正常
- `.vscode-test` 目录里没有明显的扩展安装缓存残留
- `extensions.json` 不存在，暂无证据表明被禁用扩展或固定过滤规则命中

当前最有价值的下一步仍然是：继续从 `extensionDevelopmentPath` 与 VS Code 测试宿主对本地扩展的识别机制入手，而不是再改命令注册逻辑。

---

### 3.3 `@vscode/test-electron` 缓存或版本导致异常

有社区文章提到，`.vscode-test` 缓存中的 VS Code 安装可能在某些情况下损坏或不一致，导致后续测试行为异常。

相关链接：

```text
https://symflower.com/en/company/blog/2023/vscode-test-installation/
```

建议在路径和 manifest 都确认无误后，再尝试：

```bash
rm -rf .vscode-test
npm test
```

---

## 4. 建议接手 agent 先做的最小诊断

### 4.1 修改 `src/test/runTest.ts`

目标：证明 `extensionDevelopmentPath` 的真实值就是扩展根目录。

建议临时改成：

```ts
import * as path from 'path';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const manifestPath = path.join(extensionDevelopmentPath, 'package.json');

  console.log('[test] __dirname =', __dirname);
  console.log('[test] extensionDevelopmentPath =', extensionDevelopmentPath);
  console.log('[test] extensionTestsPath =', extensionTestsPath);
  console.log('[test] package.json exists =', fs.existsSync(manifestPath));

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No package.json at extensionDevelopmentPath: ${manifestPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log('[test] manifest summary =', {
    publisher: pkg.publisher,
    name: pkg.name,
    id: `${pkg.publisher}.${pkg.name}`,
    main: pkg.main,
    engines: pkg.engines,
    activationEvents: pkg.activationEvents,
  });

  const mainPath = path.join(extensionDevelopmentPath, pkg.main ?? '');
  console.log('[test] main exists =', fs.existsSync(mainPath), mainPath);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      EXPECTED_EXTENSION_ID: `${pkg.publisher}.${pkg.name}`,
      EXPECTED_EXTENSION_PATH: fs.realpathSync(extensionDevelopmentPath),
    },
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

---

### 4.2 增加“扩展发现层”测试

先不要测命令。先测测试宿主是否能发现扩展。

在 `src/test/suite/extension.test.ts` 或单独文件中加入：

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';

suite('Extension loading diagnostics', () => {
  test('development extension should be visible to VS Code', async () => {
    const expectedId = process.env.EXPECTED_EXTENSION_ID;
    const expectedPath = process.env.EXPECTED_EXTENSION_PATH;

    assert.ok(expectedId, 'EXPECTED_EXTENSION_ID is missing');
    assert.ok(expectedPath, 'EXPECTED_EXTENSION_PATH is missing');

    const all = vscode.extensions.all.map(ext => {
      let realPath = ext.extensionUri.fsPath;

      try {
        realPath = fs.realpathSync(ext.extensionUri.fsPath);
      } catch {
        // ignore
      }

      return {
        id: ext.id,
        name: ext.packageJSON?.name,
        publisher: ext.packageJSON?.publisher,
        main: ext.packageJSON?.main,
        engines: ext.packageJSON?.engines,
        path: realPath,
        isActive: ext.isActive,
      };
    });

    const suspicious = all.filter(ext =>
      ext.id.toLowerCase().includes('smart') ||
      ext.name?.toLowerCase().includes('smart') ||
      ext.path.toLowerCase().includes('smart-page-translator')
    );

    const byPath = all.filter(ext => ext.path === expectedPath);
    const byId = vscode.extensions.getExtension(expectedId);

    console.log('[diagnostics] expectedId =', expectedId);
    console.log('[diagnostics] expectedPath =', expectedPath);
    console.log('[diagnostics] matching by path =', JSON.stringify(byPath, null, 2));
    console.log('[diagnostics] suspicious smart extensions =', JSON.stringify(suspicious, null, 2));
    console.log('[diagnostics] all extension count =', all.length);

    assert.ok(
      byId || byPath.length > 0,
      `Extension was not discovered. Expected id=${expectedId}, path=${expectedPath}`
    );
  });
});
```

---

## 5. 判定矩阵

### 情况 A：`byPath` 有结果，但 `byId` 没结果

含义：

```text
扩展已经被加载，但测试用错了扩展 ID。
```

处理：

- 打印真实 `ext.id`
- 所有测试改用真实 ID
- 确认 `publisher` 和 `name`

---

### 情况 B：`byPath` 没结果，`suspicious` 也没结果

含义：

```text
VS Code 测试宿主完全没有把当前目录当作开发扩展加载。
```

优先检查：

1. `extensionDevelopmentPath` 是否真的是扩展根目录
2. 该目录是否直接存在 `package.json`
3. `package.json` 是否有合法 `name`、`publisher`、`engines.vscode`
4. `main` 指向文件是否存在
5. 是否误用了影响扩展加载的 `launchArgs`
6. 是否 `.vscode-test` 缓存污染
7. 是否 `@vscode/test-electron` 版本太旧

---

### 情况 C：扩展可见，但 `isActive=false`

含义：

```text
已经进入激活阶段问题，不是加载阶段问题。
```

处理：

显式调用：

```ts
await ext.activate();
```

然后检查：

```ts
const commands = await vscode.commands.getCommands(true);
assert.ok(commands.includes('smartPageTranslator.translate'));
```

---

### 情况 D：扩展可见，`activate()` 抛错

含义：

```text
扩展入口执行了，但 activate 内部出错。
```

处理：

在 `activate()` 中加日志，并将非核心初始化隔离：

```ts
export async function activate(context: vscode.ExtensionContext) {
  console.log('[smart-page-translator] activate start');

  context.subscriptions.push(
    vscode.commands.registerCommand('smartPageTranslator.translate', async () => {
      // command body
    })
  );

  console.log('[smart-page-translator] main command registered');

  try {
    await initNotes(context);
  } catch (err) {
    console.error('[smart-page-translator] notes init failed', err);
  }
}
```

如果这样后命令可见，说明 notes 初始化或其他后续逻辑阻断了激活。

---

## 6. 扩展可见后再做命令注册测试

只有当扩展已经进入 `vscode.extensions.all` 后，才继续测试命令注册：

```ts
test('main command should be registered after activation', async () => {
  const extensionId = process.env.EXPECTED_EXTENSION_ID!;
  const ext = vscode.extensions.getExtension(extensionId);

  assert.ok(ext, `Extension not found: ${extensionId}`);

  try {
    await ext.activate();
  } catch (err) {
    assert.fail(`Extension activation failed: ${err instanceof Error ? err.stack : String(err)}`);
  }

  const commands = await vscode.commands.getCommands(true);

  assert.ok(
    commands.includes('smartPageTranslator.translate'),
    'Command smartPageTranslator.translate was not registered after activation'
  );
});
```

---

## 7. 推荐测试流程

### Step 1：清理测试环境

```bash
rm -rf .vscode-test
rm -rf out
npm install
npm run compile
npm test
```

---

### Step 2：只跑加载层诊断

不要先跑命令测试。

目标是拿到：

```text
[test] __dirname
[test] extensionDevelopmentPath
[test] package.json exists
[test] manifest summary
[test] main exists
[diagnostics] expectedId
[diagnostics] expectedPath
[diagnostics] matching by path
[diagnostics] suspicious smart extensions
[diagnostics] all extension count
```

---

### Step 3：根据判定矩阵定位

优先判断：

```text
扩展是否进入 vscode.extensions.all？
```

如果没有进入，继续查路径和 manifest。

如果进入了，再查 ID 和激活。

---

### Step 4：恢复 smoke test

确认加载没问题后，再恢复：

```ts
await ext.activate();
const commands = await vscode.commands.getCommands(true);
assert.ok(commands.includes('smartPageTranslator.translate'));
```

---

## 8. 不建议继续优先排查的方向

当前阶段不建议继续优先排查：

1. `activationEvents` 是否包含 `onCommand`
2. 主命令注册代码是否存在
3. Mocha `suite/test` 写法
4. 测试进程是否需要手动关闭窗口
5. `executeCommand('smartPageTranslator.translate')` 为什么失败

原因：

```text
这些都依赖扩展已经被测试宿主发现。
```

如果扩展对象根本不可见，这些测试都会失败，但它们不能解释根因。

---

## 9. 当前最有价值的下一步

接手 agent 应先提交一个只包含诊断信息的最小变更：

1. `runTest.ts` 打印并校验：
   - `__dirname`
   - `extensionDevelopmentPath`
   - `extensionTestsPath`
   - `package.json exists`
   - `publisher`
   - `name`
   - `publisher.name`
   - `main`
   - `main exists`
   - `engines.vscode`

2. 测试宿主内打印：
   - `EXPECTED_EXTENSION_ID`
   - `EXPECTED_EXTENSION_PATH`
   - `vscode.extensions.all.length`
   - 按 path 匹配结果
   - 按 smart 关键词过滤结果
   - `vscode.extensions.getExtension(EXPECTED_EXTENSION_ID)` 结果

拿到这组日志后，基本可以把问题压缩到：

```text
路径问题 / manifest 问题 / ID 问题 / VS Code 测试版本问题 / 激活内部异常
```

---

## 10. 最终判断

基于当前记录，最高概率结论是：

> `@vscode/test-electron` 的测试宿主能启动，但当前开发扩展没有作为 `extensionDevelopmentPath` 扩展进入 Extension Host；命令不存在只是这个加载失败的后续表现。

优先级最高的修复方向：

1. 证明 `extensionDevelopmentPath` 指向正确扩展根目录
2. 确认 `package.json` manifest 可被 VS Code 接受
3. 使用完整扩展 ID：`publisher.name`
4. 对齐官方 sample：`extensionTestsPath = ./suite/index`
5. 清理 `.vscode-test` 并确认测试 VS Code 版本与 `engines.vscode` 兼容

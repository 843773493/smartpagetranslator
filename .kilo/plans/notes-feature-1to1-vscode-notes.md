# Notes 功能完整化计划

## 🎯 目标

全量对照 `reference_repo\vscode-notes`，把当前仓库 Notes 功能的 package.json 声明、UI 表现、命令集补齐到与 vscode-notes 1:1 等效。

---

## 📋 当前状态速查

| 维度 | smartpagetranslator | vscode-notes（参考） | 差距 |
|---|---|---|---|
| `keybindings` | ❌ | `alt+l` listNotes / `alt+n` newNote | notebook 快捷键缺失 |
| `viewsWelcome` | ❌ | 空视图显示 Select Location | 空视图缺引导 |
| `view/title` toolbar | ✅ 3 个按钮（无图标） | 4 个按钮（有 `$(gear)`） | setupNotes 缺失 \+ 图标缺失 |
| `view/item/context` `!viewItem` | ❌ 无 | 3 条 `!viewItem` | 根节点右键菜单缺失 |
| `explorer/context` `!viewItem` | ❌ 无 | 2 条 `!viewItem` | 根节点资源管理器菜单缺失 |
| `view/title` icon | ❌ 纯文字按钮 | `$(new-file)` `$(new-folder)` `$(refresh)` `$(gear)` | 视觉体验差 |
| `listNotes` command palette | ❌ 不出现命令面板 | ✅ | 快捷唤起 bird list 缺失 |
| `command` icon（命令栏） | ❌ 无 icon（delete/rename） | `resources/light/dark/*.svg` | 菜单栏监听项无图标 |
| `Note` collapsibleState | ❌ 硬编码 Collapsed/None | ✅ 参数传入 | 子文件夹展开控制不灵活 |
| `pathExists()` | private（外部不可测） | private | 调试状态差异 |
| `NotesViewProvider.getNotes()` | ⚠️ sort 在线程内执行 | 等同 | 不影响 UI 但可优化 |

---

## ✅ 分阶段改动计划

### 阶段 1 — package.json manifest 补齐（最关键）

这些改动只改 JSON，**不碰任何 .ts 源码**。

#### 1.1 `keybindings` 新增

参考 `reference_repo/vscode-notes/package.json:118-129`：
```json
"keybindings": [
    {
        "command": "smartPageTranslator.notes.listNotes",
        "key": "alt+l",
        "mac": "alt+l"
    },
    {
        "command": "smartPageTranslator.notes.newNote",
        "key": "alt+n",
        "mac": "alt+n"
    }
]
```

**位置**：`contributes` → 字段末尾，`configuration` 之前。

#### 1.2 `viewsWelcome` 新增

参考 `reference_repo/vscode-notes/package.json:218-223`：
```json
"viewsWelcome": [
    {
        "view": "notes",
        "contents": "尚未设置笔记存储位置。\n[选择位置](command:smartPageTranslator.notes.setupNotes)"
    }
]
```

**位置**：`contributes` → 字段末尾，`configuration` 之前。

**说明**：
- `when: "notesLocation == ''"` 条件在 `contributes` 中不可以用简写，改用纯 `contents` 文字，让 `viewsWelcome` 只要 view 内容为空就显示。
- authority 在 view 内容变化后 VS Code 内建会切换显示/隐藏 Welcome。

#### 1.3 `view/item/context` 新增 `!viewItem` 入口

在 `view/item/context` 数组末尾追加（与 `note@N` 同级），完全对齐参考段落的 3 条命令：

```json
{ "command": "smartPageTranslator.notes.newNote",      "when": "view == notes && !viewItem", "group": "navigation@1" },
{ "command": "smartPageTranslator.notes.newFolder",    "when": "view == notes && !viewItem", "group": "navigation@2" },
{ "command": "smartPageTranslator.notes.refreshNotes", "when": "view == notes && !viewItem", "group": "navigation@3" }
```

`!viewItem` 命中条件：用户右键点击树视图**空白区域**（即 notesLocation 被设为但尚未有任何笔记/文件夹的场景），用于提供在该顶层空白处直接"新建笔记"的右键菜单。

#### 1.4 `view/title` 补全 `setupNotes` 按钮

参考 `reference_repo/vscode-notes/package.json:148-151`，在 `view/title` 最后追加一行：

```json
{
    "command": "smartPageTranslator.notes.setupNotes",
    "when": "view == notes",
    "group": "navigation@4"
}
```

#### 1.5 `commands` 增加 `listNotes` 条目

使 `listNotes` 在命令面板可唤起（当前 `registerCommand` 只注册了 handler，menu 中无 entry）：

```json
{
    "command": "smartPageTranslator.notes.listNotes",
    "title": "列出所有笔记",
    "category": "Smart Page Translator"
}
```

**位置**：在 `commands` 数组中 `setupNotes` 之后追加。

#### 1.6 `command` icon 补充（如资源存在则坚持对齐）

当前 `asset/resources/` 已存在 `add.svg`、`folder.svg`、`refresh.svg`、`settings.svg` 等，可同步参考资源给 `deleteNote`/`deleteFolder`/`renameNote`/`renameFolder` 加图标，暂时不做（待资源可复用时跟进）。

---

### 阶段 2 — TypeScript 来源改进

#### 2.1 `src/notes/note.ts` — 支持 `collapsibleState` 可控

当前 `Note` 构造函数硬编码 `Collapsed` / `None`，改造为形参：

```ts
constructor(
    public readonly name: string,
    public readonly location: string,
    public readonly category: string,
    public readonly tags: string,
    public readonly isDirectory: boolean = false,

    // 新增：允许外部控制展开/折叠，默认与 vscode-notes 一致
    collapsibleState: vscode.TreeItemCollapsibleState =
        isDirectory ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,

    public readonly command?: vscode.Command
) {
    super(name, collapsibleState);
    ...
}
```

**影响调用点**：`NotesViewProvider.getNotes()` 创建文件夹 Note 处，传入 `vscode.TreeItemCollapsibleState.Collapsed`（不改调用的行为，只开放接口）。

#### 2.2 `src/notes/notesViewProvider.ts` — `pathExists` 暴露给外部

```ts
// 改 private 为 public（不影响 TS 编译，但让外部可调）
public pathExists(p: string): boolean { ... }
```

#### 2.3 `src/notes/notesCommands.ts` — `setupNotes` 增加 `command` 参数让外部可测试

当前实现已可用，只需补充重载签名方便测试：

```ts
// 新增：外部可选择不手动调用 form 时也能做
export function setupNotes(command?: string): void {
```

---

### 阶段 3 — `extension.ts` 逻辑对齐 vscode-notes 结构

参考 `reference_repo/vscode-notes/src/extension.ts` 的 `activate()` 分段模式：

1. **`Notes` 类集成**：当前 `getNotesLocation`, `getNotesExtensions`, `getNotesDefaultNoteExtension` 游离在 `notesCommands.ts`，应引入静态类 `Notes`（可内联在 `extension.ts` 或单独 `notes/notes.ts`），使 `ext.extension.id`、`ext.extensionPath` 等上下文信息可统一获取。

2. **`onDidChangeConfiguration` 监听范围补全**：参考模式只监听 `notes.notesLocation`，当前对 `smartPageTranslator.notes.notesLocation` 已有监听，只需确保 `notesExtensions` 变更也触发通知（可加可不加，与 vscode-notes 保持一致更简洁，不加也行）。

3. **deactivate 保持一致**（已在编译中）。

---

### 阶段 4 — 验证 & QA

| 验证项 | 预期结果 |
|---|---|
| F5 启动，左侧 Activity Bar 出现 **Notes 图标** | ✅ 图标出现 |
| 首次打开（未配置 notesLocation）显示欢迎语 + 选择位置按钮 | ✅ viewsWelcome 生效 |
| Alt+L 唤起 QuickPick 列出笔记 | ✅ keybindings 生效 |
| Alt+N 创建新笔记 | ✅ |
| 右键笔记根区域 → 出现「新建笔记 / 新建文件夹 / 刷新」 | ✅ `!viewItem` 条目生效 |
| 右键笔记项 → 出现「打开 / 重命名 / 删除」 | ✅ `viewItem == note` |
| 右键文件夹项 → 出现「打开 / 新建笔记 / 重命名文件夹 / 删除文件夹」 | ✅ `viewItem == folder` |
| Ctrl+Shift+P → 搜 "Translate to Chinese" | ✅ command palette 正常 |
| Ctrl+Shift+P → 搜 "列出所有笔记" | ✅ 新增命令可检索 |

---

## 🔗 参考文件索引

| 参考文件 | 对应当前文件 |
|---|---|
| `reference_repo\vscode-notes\package.json:118-223` | `package.json` manifest → 补齐 keybindings / viewsWelcome / menu entries |
| `reference_repo\vscode-notes\src\extension.ts:1-111` | `src/extension.ts` activate/deactivate 结构 |
| `reference_repo\vscode-notes\src\extension.ts:113-132` | `src/notes/notesCommands.ts` Notes 静态类 |
| `reference_repo\vscode-notes\src\note.ts:1-38` | `src/notes/note.ts` collapsibleState 参数 |
| `reference_repo\vscode-notes\src\notesViewProvider.ts:1-145` | `src/notes/notesViewProvider.ts` getTreeItem / Notes 独立 |

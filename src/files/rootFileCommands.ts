import * as vscode from 'vscode';
import { HtmlPreviewManager } from './htmlPreview';
import { RootFileItem } from './rootFileItem';
import { RootFileTreeProvider } from './rootFileTreeProvider';
import { basenameOfUri, clipboardPathOfUri, displayPathOfUri, isHtmlUri, localRootUriOf, parentUriOf } from './rootFileUri';

type FileCommandTarget = RootFileItem | vscode.Uri | string | undefined;
type ClipboardMode = 'copy' | 'cut';
type RootFileClipboard = {
	readonly uri: vscode.Uri;
	readonly mode: ClipboardMode;
};

const DELETE_TO_TRASH = '移到回收站';
const DELETE_PERMANENTLY = '永久删除';
const OVERWRITE = '覆盖';
const RENAME = '重命名';

export function registerRootFileCommands(
	context: vscode.ExtensionContext,
	tree: RootFileTreeProvider,
	treeView: vscode.TreeView<RootFileItem>
): void {
	let clipboard: RootFileClipboard | undefined;
	const htmlPreview = new HtmlPreviewManager();

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.refresh', (target?: FileCommandTarget) => {
			const uri = getUri(target);
			tree.refresh(uri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.open', async (target?: FileCommandTarget) => {
			await openFile(target || selectedTreeItem(treeView));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.previewHtml', async (target?: FileCommandTarget) => {
			await previewHtmlFile(target || selectedTreeItem(treeView), htmlPreview);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.newFile', async (target?: FileCommandTarget) => {
			const created = await createFile(target);
			if (created) {
				tree.refresh(tree.parentUri(created));
				await revealIfVisible(treeView, created);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.newFolder', async (target?: FileCommandTarget) => {
			const created = await createFolder(target);
			if (created) {
				tree.refresh(tree.parentUri(created));
				await revealIfVisible(treeView, created);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.rename', async (target?: FileCommandTarget) => {
			const renamed = await renameEntry(target || selectedTreeItem(treeView));
			if (renamed) {
				tree.refresh(tree.parentUri(renamed.oldUri));
				tree.refresh(tree.parentUri(renamed.newUri));
				await revealIfVisible(treeView, renamed.newUri);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.delete', async (target?: FileCommandTarget) => {
			const deleted = await deleteEntry(target || selectedTreeItem(treeView));
			if (deleted) {
				tree.refresh(tree.parentUri(deleted));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.copy', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			clipboard = { uri, mode: 'copy' };
			void vscode.window.showInformationMessage(`已复制：${displayPathOfUri(uri)}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.cut', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			clipboard = { uri, mode: 'cut' };
			void vscode.window.showInformationMessage(`已剪切：${displayPathOfUri(uri)}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.paste', async (target?: FileCommandTarget) => {
			const pasted = await pasteEntry(clipboard, target || selectedTreeItem(treeView));
			if (pasted) {
				tree.refresh(tree.parentUri(pasted.target));
				if (pasted.mode === 'cut') {
					tree.refresh(tree.parentUri(pasted.source));
					clipboard = undefined;
				}
				await revealIfVisible(treeView, pasted.target);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.addQuickPath', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			const added = await tree.addQuickPath(uri);
			if (added) {
				void vscode.window.showInformationMessage(`已添加快捷路径：${displayPathOfUri(uri)}`);
			} else {
				void vscode.window.showInformationMessage(`快捷路径已存在或不是文件夹：${displayPathOfUri(uri)}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.removeQuickPath', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			const removed = await tree.removeQuickPath(uri);
			if (removed) {
				void vscode.window.showInformationMessage(`已删除快捷路径：${displayPathOfUri(uri)}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.copyPath', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			const copiedPath = clipboardPathOfUri(uri);
			await vscode.env.clipboard.writeText(copiedPath);
			void vscode.window.showInformationMessage(`已复制路径：${copiedPath}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.revealInOS', async (target?: FileCommandTarget) => {
			const uri = requireUri(target || selectedTreeItem(treeView));
			await revealInOS(uri);
		})
	);
}

async function openFile(target?: FileCommandTarget): Promise<void> {
	const uri = requireUri(target);
	const stat = await vscode.workspace.fs.stat(uri);
	if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
		await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
		return;
	}

	const document = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(document);
}

async function previewHtmlFile(target: FileCommandTarget, htmlPreview: HtmlPreviewManager): Promise<void> {
	try {
		const uri = requireUri(target);
		const stat = await vscode.workspace.fs.stat(uri);
		if (isDirectory(stat)) {
			void vscode.window.showWarningMessage('只能预览 HTML 文件。');
			return;
		}

		if (!isHtmlUri(uri)) {
			void vscode.window.showWarningMessage('只能预览 .html 或 .htm 文件。');
			return;
		}

		await htmlPreview.open(uri);
	} catch (err) {
		await showFileOperationError('预览 HTML 失败', err);
	}
}

async function createFile(target?: FileCommandTarget): Promise<vscode.Uri | undefined> {
	const directory = await resolveDirectory(target);
	const name = await askEntryName('新文件名称？', '', directory);
	if (!name) {
		return undefined;
	}

	const uri = vscode.Uri.joinPath(directory, name);
	if (await pathExists(uri)) {
		await vscode.window.showWarningMessage(`'${name}' 已存在。`);
		return undefined;
	}

	try {
		await vscode.workspace.fs.writeFile(uri, new Uint8Array());
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document);
		return uri;
	} catch (err) {
		await showFileOperationError('创建文件失败', err);
		return undefined;
	}
}

async function createFolder(target?: FileCommandTarget): Promise<vscode.Uri | undefined> {
	const directory = await resolveDirectory(target);
	const name = await askEntryName('新文件夹名称？', '', directory);
	if (!name) {
		return undefined;
	}

	const uri = vscode.Uri.joinPath(directory, name);
	if (await pathExists(uri)) {
		await vscode.window.showWarningMessage(`'${name}' 已存在。`);
		return undefined;
	}

	try {
		await vscode.workspace.fs.createDirectory(uri);
		return uri;
	} catch (err) {
		await showFileOperationError('创建文件夹失败', err);
		return undefined;
	}
}

async function renameEntry(target?: FileCommandTarget): Promise<{ oldUri: vscode.Uri; newUri: vscode.Uri } | undefined> {
	const uri = requireUri(target);
	const oldName = basenameOfUri(uri);
	const newName = await askEntryName('新名称？', oldName, parentUriOf(uri));
	if (!newName || newName === oldName) {
		return undefined;
	}

	const newUri = vscode.Uri.joinPath(parentUriOf(uri), newName);
	if (await pathExists(newUri)) {
		await vscode.window.showWarningMessage(`'${newName}' 已存在。`);
		return undefined;
	}

	try {
		await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
		return { oldUri: uri, newUri };
	} catch (err) {
		await showFileOperationError('重命名失败', err);
		return undefined;
	}
}

async function deleteEntry(target?: FileCommandTarget): Promise<vscode.Uri | undefined> {
	const uri = requireUri(target);
	const basename = basenameOfUri(uri) || displayPathOfUri(uri);
	const selected = await vscode.window.showWarningMessage(
		`确定要删除 '${basename}' 吗？`,
		{ modal: true },
		DELETE_TO_TRASH,
		DELETE_PERMANENTLY
	);

	if (!selected) {
		return undefined;
	}

	try {
		await vscode.workspace.fs.delete(uri, {
			recursive: true,
			useTrash: selected === DELETE_TO_TRASH
		});
		return uri;
	} catch (err) {
		await showFileOperationError('删除失败', err);
		return undefined;
	}
}

async function pasteEntry(
	clipboard: RootFileClipboard | undefined,
	target?: FileCommandTarget
): Promise<{ source: vscode.Uri; target: vscode.Uri; mode: ClipboardMode } | undefined> {
	if (!clipboard) {
		void vscode.window.showWarningMessage('没有可粘贴的文件或文件夹。');
		return undefined;
	}

	const destinationDirectory = await resolveDirectory(target);
	const source = clipboard.uri;
	const sourceStat = await vscode.workspace.fs.stat(source);
	if (isDirectory(sourceStat) && isSameOrChildUri(source, destinationDirectory)) {
		void vscode.window.showWarningMessage('不能把文件夹粘贴到自身或其子目录。');
		return undefined;
	}

	const pastedName = basenameOfUri(source);
	let targetUri = vscode.Uri.joinPath(destinationDirectory, pastedName);
	let overwrite = false;

	if (await pathExists(targetUri)) {
		const selected = await vscode.window.showWarningMessage(
			`'${pastedName}' 已存在。`,
			{ modal: true },
			OVERWRITE,
			RENAME
		);

		if (selected === OVERWRITE) {
			if (isSameUri(source, targetUri)) {
				void vscode.window.showWarningMessage('源路径和目标路径相同，不能覆盖自身。');
				return undefined;
			}
			overwrite = true;
		} else if (selected === RENAME) {
			const newName = await askEntryName('粘贴为？', pastedName, destinationDirectory);
			if (!newName) {
				return undefined;
			}
			targetUri = vscode.Uri.joinPath(destinationDirectory, newName);
			if (await pathExists(targetUri)) {
				void vscode.window.showWarningMessage(`'${newName}' 已存在。`);
				return undefined;
			}
		} else {
			return undefined;
		}
	}

	try {
		if (clipboard.mode === 'copy') {
			await copyEntry(source, targetUri, sourceStat, overwrite);
		} else {
			await moveEntry(source, targetUri, sourceStat, overwrite);
		}
		return { source, target: targetUri, mode: clipboard.mode };
	} catch (err) {
		await showFileOperationError(clipboard.mode === 'copy' ? '复制粘贴失败' : '剪切粘贴失败', err);
		return undefined;
	}
}

async function copyEntry(
	source: vscode.Uri,
	target: vscode.Uri,
	sourceStat: vscode.FileStat,
	overwrite: boolean
): Promise<void> {
	if (isSameFileSystem(source, target)) {
		await vscode.workspace.fs.copy(source, target, { overwrite });
		return;
	}

	await copyEntryAcrossFileSystems(source, target, sourceStat, overwrite);
}

async function moveEntry(
	source: vscode.Uri,
	target: vscode.Uri,
	sourceStat: vscode.FileStat,
	overwrite: boolean
): Promise<void> {
	if (isSameFileSystem(source, target)) {
		await vscode.workspace.fs.rename(source, target, { overwrite });
		return;
	}

	await copyEntryAcrossFileSystems(source, target, sourceStat, overwrite);
	await vscode.workspace.fs.delete(source, { recursive: true, useTrash: false });
}

async function copyEntryAcrossFileSystems(
	source: vscode.Uri,
	target: vscode.Uri,
	sourceStat: vscode.FileStat,
	overwrite: boolean
): Promise<void> {
	if (await pathExists(target)) {
		if (!overwrite) {
			throw vscode.FileSystemError.FileExists(target);
		}
		await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
	}

	if (isDirectory(sourceStat)) {
		await vscode.workspace.fs.createDirectory(target);
		const children = await vscode.workspace.fs.readDirectory(source);
		for (const [name] of children) {
			const childSource = vscode.Uri.joinPath(source, name);
			const childTarget = vscode.Uri.joinPath(target, name);
			const childStat = await vscode.workspace.fs.stat(childSource);
			await copyEntryAcrossFileSystems(childSource, childTarget, childStat, false);
		}
		return;
	}

	const content = await vscode.workspace.fs.readFile(source);
	await vscode.workspace.fs.writeFile(target, content);
}

async function resolveDirectory(target?: FileCommandTarget): Promise<vscode.Uri> {
	const uri = getUri(target);
	if (!uri) {
		const roots = vscode.workspace.workspaceFolders;
		if (roots && roots.length > 0) {
			return roots[0].uri;
		}
		return localRootUriOf(process.cwd());
	}

	const stat = await vscode.workspace.fs.stat(uri);
	if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
		return uri;
	}

	return parentUriOf(uri);
}

async function askEntryName(prompt: string, value = '', targetDirectory?: vscode.Uri): Promise<string | undefined> {
	return vscode.window.showInputBox({
		prompt,
		value,
		validateInput: (input) => validateEntryName(input, targetDirectory)
	});
}

function validateEntryName(value: string, targetDirectory?: vscode.Uri): string | undefined {
	const name = value.trim();
	if (!name) {
		return '名称不能为空。';
	}
	if (name !== value) {
		return '名称前后不能包含空白字符。';
	}
	if (name.includes('/') || name.includes('\\')) {
		return '名称不能包含路径分隔符。';
	}
	if (targetDirectory?.scheme === 'file' && process.platform === 'win32' && /[<>:"|?*]/.test(name)) {
		return '名称包含 Windows 不支持的字符。';
	}
	return undefined;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function getUri(target?: FileCommandTarget): vscode.Uri | undefined {
	if (!target) {
		return undefined;
	}

	if (target instanceof RootFileItem) {
		return target.uri;
	}

	if (target instanceof vscode.Uri) {
		return target;
	}

	if (typeof target === 'string') {
		return vscode.Uri.file(target);
	}

	const possibleUri = (target as { uri?: vscode.Uri; resourceUri?: vscode.Uri }).uri
		|| (target as { uri?: vscode.Uri; resourceUri?: vscode.Uri }).resourceUri;
	if (possibleUri instanceof vscode.Uri) {
		return possibleUri;
	}

	return undefined;
}

function requireUri(target?: FileCommandTarget): vscode.Uri {
	const uri = getUri(target);
	if (!uri) {
		throw new Error('文件命令缺少目标路径。');
	}
	return uri;
}

function selectedTreeItem(treeView: vscode.TreeView<RootFileItem>): RootFileItem | undefined {
	return treeView.selection[0];
}

function isDirectory(stat: vscode.FileStat): boolean {
	return (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
}

function isSameFileSystem(left: vscode.Uri, right: vscode.Uri): boolean {
	return left.scheme === right.scheme && left.authority === right.authority;
}

function isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
	return left.toString() === right.toString();
}

function isSameOrChildUri(parent: vscode.Uri, child: vscode.Uri): boolean {
	if (!isSameFileSystem(parent, child)) {
		return false;
	}

	const parentPath = normalizeUriPath(parent.path);
	const childPath = normalizeUriPath(child.path);
	return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function normalizeUriPath(value: string): string {
	const normalized = value.replace(/\/+$/g, '');
	return normalized || '/';
}

async function revealIfVisible(treeView: vscode.TreeView<RootFileItem>, uri: vscode.Uri): Promise<void> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		await treeView.reveal(RootFileItem.fromUri(uri, stat.type), { select: true, focus: false });
	} catch {
		// 新建/重命名已经完成，reveal 失败不应覆盖真实操作结果。
	}
}

async function revealInOS(uri: vscode.Uri): Promise<void> {
	if (uri.scheme !== 'file') {
		await vscode.env.clipboard.writeText(clipboardPathOfUri(uri));
		void vscode.window.showInformationMessage('远程资源不能在本机系统文件管理器中直接显示，已复制远程路径。');
		return;
	}

	try {
		await vscode.commands.executeCommand('revealFileInOS', uri);
	} catch {
		await vscode.env.openExternal(uri);
	}
}

async function showFileOperationError(prefix: string, err: unknown): Promise<void> {
	const detail = err instanceof Error ? err.message : String(err);
	console.error(`${prefix}:`, err);
	void vscode.window.showErrorMessage(`${prefix}：${detail}`);
}

import * as path from 'path';
import * as vscode from 'vscode';
import { RootFileItem } from './rootFileItem';
import { RootFileTreeProvider } from './rootFileTreeProvider';

type FileCommandTarget = RootFileItem | vscode.Uri | string | undefined;

const DELETE_TO_TRASH = '移到回收站';
const DELETE_PERMANENTLY = '永久删除';

export function registerRootFileCommands(
	context: vscode.ExtensionContext,
	tree: RootFileTreeProvider,
	treeView: vscode.TreeView<RootFileItem>
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.refresh', (target?: FileCommandTarget) => {
			const uri = getUri(target);
			tree.refresh(uri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.open', async (target?: FileCommandTarget) => {
			await openFile(target);
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
			const renamed = await renameEntry(target);
			if (renamed) {
				tree.refresh(tree.parentUri(renamed.oldUri));
				tree.refresh(tree.parentUri(renamed.newUri));
				await revealIfVisible(treeView, renamed.newUri);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.delete', async (target?: FileCommandTarget) => {
			const deleted = await deleteEntry(target);
			if (deleted) {
				tree.refresh(tree.parentUri(deleted));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.copyPath', async (target?: FileCommandTarget) => {
			const uri = requireUri(target);
			await vscode.env.clipboard.writeText(uri.fsPath);
			void vscode.window.showInformationMessage(`已复制路径：${uri.fsPath}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.rootFiles.revealInOS', async (target?: FileCommandTarget) => {
			const uri = requireUri(target);
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

async function createFile(target?: FileCommandTarget): Promise<vscode.Uri | undefined> {
	const directory = await resolveDirectory(target);
	const name = await askEntryName('新文件名称？');
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
	const name = await askEntryName('新文件夹名称？');
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
	const oldName = path.basename(uri.fsPath);
	const newName = await askEntryName('新名称？', oldName);
	if (!newName || newName === oldName) {
		return undefined;
	}

	const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(uri.fsPath)), newName);
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
	const basename = path.basename(uri.fsPath) || uri.fsPath;
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

async function resolveDirectory(target?: FileCommandTarget): Promise<vscode.Uri> {
	const uri = getUri(target);
	if (!uri) {
		const roots = vscode.workspace.workspaceFolders;
		if (roots && roots.length > 0) {
			return roots[0].uri;
		}
		return vscode.Uri.file(path.parse(process.cwd()).root);
	}

	const stat = await vscode.workspace.fs.stat(uri);
	if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
		return uri;
	}

	return vscode.Uri.file(path.dirname(uri.fsPath));
}

async function askEntryName(prompt: string, value = ''): Promise<string | undefined> {
	return vscode.window.showInputBox({
		prompt,
		value,
		validateInput: validateEntryName
	});
}

function validateEntryName(value: string): string | undefined {
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
	if (process.platform === 'win32' && /[<>:"|?*]/.test(name)) {
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

async function revealIfVisible(treeView: vscode.TreeView<RootFileItem>, uri: vscode.Uri): Promise<void> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		await treeView.reveal(RootFileItem.fromUri(uri, stat.type), { select: true, focus: false });
	} catch {
		// 新建/重命名已经完成，reveal 失败不应覆盖真实操作结果。
	}
}

async function revealInOS(uri: vscode.Uri): Promise<void> {
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

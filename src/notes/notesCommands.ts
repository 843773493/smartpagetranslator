import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { rimraf } from 'rimraf';
import { Note } from './note';
import { NotesViewProvider } from './notesViewProvider';

export function getNotesLocation(): string {
	return String(vscode.workspace.getConfiguration('smartPageTranslator').get('notes.notesLocation'));
}

export function getNotesDefaultNoteExtension(): string {
	return String(vscode.workspace.getConfiguration('smartPageTranslator').get('notes.notesDefaultNoteExtension'));
}

export function getNotesExtensions(): string {
	return String(vscode.workspace.getConfiguration('smartPageTranslator').get('notes.notesExtensions'));
}

export function deleteNote(note: Note, tree: NotesViewProvider): void {
	vscode.window.showWarningMessage(`确定要删除 '${note.name}' 吗？此操作不可撤销。`, '是', '否').then(result => {
		if (result === '是') {
			fs.unlink(path.join(String(note.location), String(note.name)), (err) => {
				if (err) {
					console.error(err);
					return vscode.window.showErrorMessage(`删除 ${note.name} 失败。`);
				}
				vscode.window.showInformationMessage(`成功删除 ${note.name}。`);
			});
			tree.refresh();
		}
	});
}

export function deleteFolder(folder: Note, tree: NotesViewProvider): void {
	if (!folder.isFolder) {
		vscode.window.showErrorMessage('所选项目不是文件夹。');
		return;
	}

	vscode.window.showWarningMessage(`确定要删除文件夹 '${folder.name}' 及其所有内容吗？此操作不可撤销。`, '是', '否').then(result => {
		if (result === '是') {
			const folderPath = path.join(folder.location, folder.name);

			rimraf(folderPath).then((deleted) => {
				if (deleted) {
					vscode.window.showInformationMessage(`成功删除文件夹 ${folder.name}。`);
					tree.refresh();
				}
			}).catch((err) => {
				console.error(err);
				vscode.window.showErrorMessage(`删除文件夹 ${folder.name} 失败。`);
			});
		}
	});
}

export function listNotes(): void {
	let notesLocation = String(getNotesLocation());
	let notesExtensions = String(getNotesExtensions());
	fs.readdir(String(notesLocation), (err, files) => {
		if (err) {
			console.error(err);
			return vscode.window.showErrorMessage('读取笔记文件夹失败。');
		}
		else {
			vscode.window.showQuickPick(files).then(file => {
				vscode.window.showTextDocument(vscode.Uri.file(path.join(String(notesLocation), String(file))));
			});
		}
	});
}

export function newNote(tree: NotesViewProvider, folder?: Note): void {
	let notesLocation = folder ? path.join(folder.location, folder.name) : String(getNotesLocation());
	let notesDefaultNoteExtension = String(getNotesDefaultNoteExtension());

	vscode.window.showInputBox({
		prompt: '笔记名称？',
		value: '',
	}).then(noteName => {
		if (!noteName) {
			return;
		}

		let fileName: string = `${noteName}`;
		let filePath: string = path.join(notesLocation, `${fileName.replace(/\:/gi, '')}.${notesDefaultNoteExtension}`);
		let firstLine: string = "# " + fileName + "\n\n";
		let noteExists = fs.existsSync(String(filePath));

		if (!noteExists) {
			fs.writeFile(filePath, firstLine, err => {
				if (err) {
					console.error(err);
					return vscode.window.showErrorMessage('创建新笔记失败。');
				}
				else {
					let file = vscode.Uri.file(filePath);
					vscode.window.showTextDocument(file).then(() => {
						vscode.commands.executeCommand('cursorMove', { 'to': 'viewPortBottom' });
					});
				}
			});
			tree.refresh();
		}
		else {
			return vscode.window.showWarningMessage('同名笔记已存在。');
		}
	});
}

export function newFolder(tree: NotesViewProvider, parentFolder?: Note): void {
	let parentLocation = parentFolder ? path.join(parentFolder.location, parentFolder.name) : String(getNotesLocation());

	vscode.window.showInputBox({
		prompt: '文件夹名称？',
		value: '',
	}).then(folderName => {
		if (!folderName) {
			return;
		}

		let folderPath: string = path.join(parentLocation, folderName);
		let folderExists = fs.existsSync(String(folderPath));

		if (!folderExists) {
			fs.mkdir(folderPath, { recursive: true }, err => {
				if (err) {
					console.error(err);
					return vscode.window.showErrorMessage('创建新文件夹失败。');
				}
				else {
					vscode.window.showInformationMessage(`成功创建文件夹 ${folderName}。`);
				}
			});
			tree.refresh();
		}
		else {
			return vscode.window.showWarningMessage('同名文件夹已存在。');
		}
	});
}

export function openNote(note: Note | string): void {
	if (typeof note !== 'string' && note.isFolder) {
		return;
	}

	let filePath: string;

	if (typeof note === 'string') {
		filePath = note;
	}
	else {
		filePath = path.join(String(note.location), String(note.name));
	}

	vscode.window.showTextDocument(vscode.Uri.file(filePath));
}

export function refreshNotes(tree: NotesViewProvider): void {
	tree.refresh();
}

export function renameNote(note: Note, tree: NotesViewProvider): void {
	if (note.isFolder) {
		return;
	}

	let noteExtension = note.name.split('.').pop();

	vscode.window.showInputBox({
		prompt: '新笔记名称？',
		value: note.name
	}).then(newNoteName => {
		if (!newNoteName || newNoteName === note.name) {
			return;
		}

		let newNoteExtension = path.extname(newNoteName).replace('.', '');
		let noteName: string = '';

		if (String(getNotesExtensions()).split(',').includes(newNoteExtension)) {
			noteName = newNoteName;
		}
		else if (path.extname(newNoteName) === '') {
			noteName = newNoteName + '.' + noteExtension;
		}
		else {
			noteName = path.basename(newNoteName, path.extname(newNoteName)) + '.' + noteExtension;
		}

		let newNotePath = path.join(note.location, noteName);
		if (fs.existsSync(newNotePath)) {
			vscode.window.showWarningMessage(`'${noteName}' 已存在。`);
			return;
		}

		vscode.window.showInformationMessage(`'${note.name}' 已重命名为 '${noteName}'。`);
		fs.renameSync(path.join(note.location, note.name), newNotePath);
		tree.refresh();
	});
}

export function renameFolder(folder: Note, tree: NotesViewProvider): void {
	if (!folder.isFolder) {
		return;
	}

	vscode.window.showInputBox({
		prompt: '新文件夹名称？',
		value: folder.name
	}).then(newFolderName => {
		if (!newFolderName || newFolderName === folder.name) {
			return;
		}

		let newFolderPath = path.join(folder.location, newFolderName);
		if (fs.existsSync(newFolderPath)) {
			vscode.window.showWarningMessage(`'${newFolderName}' 已存在。`);
			return;
		}

		vscode.window.showInformationMessage(`'${folder.name}' 已重命名为 '${newFolderName}'。`);
		fs.renameSync(path.join(folder.location, folder.name), newFolderPath);
		tree.refresh();
	});
}

export function setupNotes(tree?: NotesViewProvider): void {
	const notesLocation = getNotesLocation();
	if (notesLocation) {
		vscode.commands.executeCommand('workbench.action.openSettings', `@ext:smart-page-translator`);
		return;
	}

	let openDialogOptions: vscode.OpenDialogOptions = {
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: '选择'
	};

	vscode.window.showOpenDialog(openDialogOptions).then(fileUri => {
		if (fileUri && fileUri[0]) {
			let notesConfiguration = vscode.workspace.getConfiguration('smartPageTranslator');
			notesConfiguration.update('notes.notesLocation', path.normalize(fileUri[0].fsPath), true).then(() => {
				vscode.window.showWarningMessage(
					`检测到存储位置已更改。需要重新加载窗口使更改生效。`,
					'重新加载'
				).then(selectedAction => {
					if (selectedAction === '重新加载') {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			});
		}
	});
}

export function registerNotesCommands(context: vscode.ExtensionContext, tree: NotesViewProvider): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.deleteNote', (note: Note) => {
			deleteNote(note, tree);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.deleteFolder', (folder: Note) => {
			deleteFolder(folder, tree);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.listNotes', () => {
			listNotes();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.newNote', (folder?: Note) => {
			newNote(tree, folder);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.newFolder', (parentFolder?: Note) => {
			newFolder(tree, parentFolder);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.openNote', (note: Note | string) => {
			openNote(note);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.refreshNotes', () => {
			refreshNotes(tree);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.renameNote', (note: Note) => {
			renameNote(note, tree);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.renameFolder', (folder: Note) => {
			renameFolder(folder, tree);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.notes.setupNotes', () => {
			setupNotes(tree);
		})
	);
}
import * as vscode from 'vscode';
import { displayPathOfUri, isHtmlUri, labelOfUri } from './rootFileUri';

export type RootFileItemKind = 'file' | 'directory' | 'message';

export class RootFileItem extends vscode.TreeItem {
	public readonly kind: RootFileItemKind;

	constructor(
		public readonly uri: vscode.Uri,
		public readonly name: string,
		kind: RootFileItemKind,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly isRoot: boolean = false,
		public readonly isShortcutRoot: boolean = false
	) {
		super(name, collapsibleState);
		this.kind = kind;
		this.id = kind === 'message' ? `message:${name}` : uri.toString();
		this.tooltip = kind === 'message' ? name : displayPathOfUri(uri);
		this.resourceUri = kind === 'message' ? undefined : uri;
		this.contextValue = this.resolveContextValue(uri, kind, isRoot);
		this.description = isShortcutRoot ? '快捷路径' : undefined;

		if (isShortcutRoot) {
			this.iconPath = new vscode.ThemeIcon('bookmark');
		} else if (kind === 'directory') {
			this.iconPath = new vscode.ThemeIcon(isRoot ? 'root-folder' : 'folder');
		} else if (kind === 'file') {
			this.iconPath = vscode.ThemeIcon.File;
			// 使用 VS Code API 命令传递 URI，避免自定义命令参数被转换为随树节点刷新失效的临时代理。
			this.command = isHtmlUri(uri)
				? {
					command: 'vscode.openWith',
					title: '预览 HTML',
					arguments: [uri, 'smartPageTranslator.htmlPreview']
				}
				: {
					command: 'vscode.open',
					title: '打开文件',
					arguments: [uri]
				};
		} else {
			this.iconPath = new vscode.ThemeIcon('warning');
		}
	}

	public static fromUri(uri: vscode.Uri, type: vscode.FileType, isRoot = false, isShortcutRoot = false): RootFileItem {
		const isDirectory = (type & vscode.FileType.Directory) === vscode.FileType.Directory;
		const name = labelOfUri(uri, isRoot);
		return new RootFileItem(
			uri,
			name,
			isDirectory ? 'directory' : 'file',
			isDirectory
				? (isRoot ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
				: vscode.TreeItemCollapsibleState.None,
			isRoot,
			isShortcutRoot
		);
	}

	public static message(message: string): RootFileItem {
		return new RootFileItem(
			vscode.Uri.parse('smart-page-translator-root-files:/message'),
			message,
			'message',
			vscode.TreeItemCollapsibleState.None
		);
	}

	private resolveContextValue(uri: vscode.Uri, kind: RootFileItemKind, isRoot: boolean): string {
		if (kind === 'message') {
			return 'rootFilesMessage';
		}

		if (isRoot) {
			return this.isShortcutRoot ? 'rootFilesShortcutRoot' : 'rootFilesRoot';
		}

		if (kind === 'directory') {
			return 'rootFilesFolder';
		}

		return isHtmlUri(uri) ? 'rootFilesHtmlFile' : 'rootFilesFile';
	}
}

import * as vscode from 'vscode';
import * as path from 'path';

export class Note extends vscode.TreeItem {
	public readonly isFolder: boolean;
	public readonly fullPath: string;

	constructor(
		public readonly name: string,
		public readonly location: string,
		public readonly category: string,
		public readonly tags: string,
		public readonly isDirectory: boolean = false,
		public readonly command?: vscode.Command
	) {
		super(name, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.name = name;
		this.location = location;
		this.category = category;
		this.tags = tags;
		this.isFolder = isDirectory;
		this.fullPath = path.join(location, name);

		if (isDirectory) {
			this.iconPath = new vscode.ThemeIcon('folder');
		} else {
			this.iconPath = vscode.ThemeIcon.File;
		}

		this.contextValue = isDirectory ? 'folder' : 'note';
	}

	tooltip = this.name;
}
import * as path from 'path';
import * as vscode from 'vscode';
import { RootFileItem } from './rootFileItem';
import { localRootUriOf, parentUriOf, rootUriOf } from './rootFileUri';

type CachedChildren = {
	readonly createdAt: number;
	readonly items: RootFileItem[];
};

const CACHE_TTL_MS = 30_000;

type RootFileTreeRuntime = {
	readonly remoteName?: string;
	readonly extensionKind: vscode.ExtensionKind;
};

export class RootFileTreeProvider implements vscode.TreeDataProvider<RootFileItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RootFileItem | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly childrenCache = new Map<string, CachedChildren>();

	constructor(private readonly runtime: RootFileTreeRuntime) {}

	public getTreeItem(item: RootFileItem): vscode.TreeItem {
		return item;
	}

	public async getChildren(item?: RootFileItem): Promise<RootFileItem[]> {
		if (item?.kind === 'message' || item?.kind === 'file') {
			return [];
		}

		if (!item) {
			return this.getRootItems();
		}

		return this.getDirectoryChildren(item.uri);
	}

	public refresh(uri?: vscode.Uri): void {
		if (!uri) {
			this.childrenCache.clear();
			this.onDidChangeTreeDataEmitter.fire(undefined);
			return;
		}

		this.childrenCache.delete(this.cacheKey(uri));
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	public invalidateParent(uri: vscode.Uri): void {
		this.refresh(this.parentUri(uri));
	}

	public parentUri(uri: vscode.Uri): vscode.Uri {
		return parentUriOf(uri);
	}

	private async getRootItems(): Promise<RootFileItem[]> {
		const roots = this.getCandidateRootUris();
		if (roots.length === 0 && this.isWaitingForRemoteWorkspace()) {
			return [RootFileItem.message('已连接 Remote-SSH。打开一个远程文件夹后显示服务器根目录。')];
		}

		const items: RootFileItem[] = [];

		for (const uri of roots) {
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
					items.push(RootFileItem.fromUri(uri, stat.type, true));
				}
			} catch (err) {
				console.warn(`读取根目录失败: ${uri.fsPath}`, err);
			}
		}

		if (items.length === 0) {
			return [RootFileItem.message('没有找到可访问的根目录')];
		}

		return items.sort(compareRootFileItems);
	}

	private getCandidateRootUris(): vscode.Uri[] {
		const roots = new Map<string, vscode.Uri>();
		const addUri = (uri: vscode.Uri): void => {
			roots.set(uri.toString().toLowerCase(), uri);
		};
		const addLocalRoot = (rootPath: string | undefined): void => {
			if (!rootPath) {
				return;
			}
			addUri(localRootUriOf(rootPath));
		};

		const workspaceFolders = vscode.workspace.workspaceFolders || [];
		for (const folder of vscode.workspace.workspaceFolders || []) {
			addUri(rootUriOf(folder.uri));
		}

		if (workspaceFolders.length === 0 && this.isWaitingForRemoteWorkspace()) {
			return [];
		}

		if (workspaceFolders.length === 0 || workspaceFolders.every(folder => folder.uri.scheme === 'file')) {
			addLocalRoot(process.cwd());
			addLocalRoot(process.env.SystemDrive);
			addLocalRoot(process.env.HOMEDRIVE);
		}

		if (roots.size === 0) {
			addLocalRoot(path.parse(process.cwd()).root);
		}

		return [...roots.values()];
	}

	private isWaitingForRemoteWorkspace(): boolean {
		return Boolean(this.runtime.remoteName)
			&& this.runtime.extensionKind === vscode.ExtensionKind.UI
			&& (vscode.workspace.workspaceFolders || []).length === 0;
	}

	private async getDirectoryChildren(uri: vscode.Uri): Promise<RootFileItem[]> {
		const key = this.cacheKey(uri);
		const cached = this.childrenCache.get(key);
		if (cached && Date.now() - cached.createdAt <= CACHE_TTL_MS) {
			return cached.items;
		}

		try {
			const entries = await vscode.workspace.fs.readDirectory(uri);
			const items = entries
				.map(([name, type]) => RootFileItem.fromUri(vscode.Uri.joinPath(uri, name), type))
				.sort(compareRootFileItems);
			this.childrenCache.set(key, { createdAt: Date.now(), items });
			return items;
		} catch (err) {
			console.warn(`读取目录失败: ${uri.fsPath}`, err);
			return [RootFileItem.message(`无法读取：${uri.fsPath}`)];
		}
	}

	private cacheKey(uri: vscode.Uri): string {
		return uri.toString();
	}
}

function compareRootFileItems(a: RootFileItem, b: RootFileItem): number {
	if (a.kind === 'directory' && b.kind !== 'directory') {
		return -1;
	}
	if (a.kind !== 'directory' && b.kind === 'directory') {
		return 1;
	}
	return a.name.localeCompare(b.name, undefined, {
		numeric: true,
		sensitivity: 'base'
	});
}

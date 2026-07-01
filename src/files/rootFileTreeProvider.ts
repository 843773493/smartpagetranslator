import * as path from 'path';
import * as vscode from 'vscode';
import { RootFileItem } from './rootFileItem';
import { localRootUriOf, parentUriOf, rootUriOf } from './rootFileUri';

type CachedChildren = {
	readonly createdAt: number;
	readonly items: RootFileItem[];
};

const CACHE_TTL_MS = 30_000;
const QUICK_PATHS_KEY = 'rootFiles.quickPaths';

type RootFileTreeRuntime = {
	readonly remoteName?: string;
	readonly extensionKind: vscode.ExtensionKind;
};

export class RootFileTreeProvider implements vscode.TreeDataProvider<RootFileItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<RootFileItem | undefined>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
	private readonly childrenCache = new Map<string, CachedChildren>();
	private quickPathUris: vscode.Uri[];

	constructor(
		private readonly runtime: RootFileTreeRuntime,
		private readonly storage: vscode.Memento
	) {
		this.quickPathUris = this.loadQuickPathUris();
	}

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

	public async addQuickPath(uri: vscode.Uri): Promise<boolean> {
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.Directory) !== vscode.FileType.Directory) {
			return false;
		}

		if (this.quickPathUris.some(existing => existing.toString() === uri.toString())) {
			return false;
		}

		this.quickPathUris = [...this.quickPathUris, uri];
		await this.saveQuickPathUris();
		this.refresh();
		return true;
	}

	public async removeQuickPath(uri: vscode.Uri): Promise<boolean> {
		const nextUris = this.quickPathUris.filter(existing => existing.toString() !== uri.toString());
		if (nextUris.length === this.quickPathUris.length) {
			return false;
		}

		this.quickPathUris = nextUris;
		await this.saveQuickPathUris();
		this.refresh();
		return true;
	}

	private async getRootItems(): Promise<RootFileItem[]> {
		const roots = this.getCandidateRootUris();
		const quickPathItems = this.getQuickPathRootItems();

		if (roots.length === 0 && quickPathItems.length === 0 && this.isWaitingForRemoteWorkspace()) {
			return [RootFileItem.message('已连接 Remote-SSH。打开一个远程文件夹后显示服务器根目录。')];
		}

		const items: RootFileItem[] = [...quickPathItems];

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

	private getQuickPathRootItems(): RootFileItem[] {
		return this.quickPathUris.map(uri => RootFileItem.fromUri(uri, vscode.FileType.Directory, true, true));
	}

	private loadQuickPathUris(): vscode.Uri[] {
		const values = this.storage.get<string[]>(QUICK_PATHS_KEY, []);
		return values.map(value => vscode.Uri.parse(value));
	}

	private async saveQuickPathUris(): Promise<void> {
		await this.storage.update(QUICK_PATHS_KEY, this.quickPathUris.map(uri => uri.toString()));
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

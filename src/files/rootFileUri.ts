import * as path from 'path';
import * as vscode from 'vscode';

export function basenameOfUri(uri: vscode.Uri): string {
	if (uri.scheme === 'file') {
		return path.basename(uri.fsPath);
	}

	return path.posix.basename(uri.path);
}

export function displayPathOfUri(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

export function clipboardPathOfUri(uri: vscode.Uri): string {
	return uri.scheme === 'file' ? uri.fsPath : uri.path;
}

export function labelOfUri(uri: vscode.Uri, isRoot = false): string {
	const basename = basenameOfUri(uri);
	if (basename) {
		return basename;
	}

	if (isRoot && uri.scheme !== 'file') {
		return `${formatAuthority(uri)}:${uri.path || '/'}`;
	}

	return uri.fsPath || uri.path || uri.toString(true);
}

export function isHtmlUri(uri: vscode.Uri): boolean {
	const name = basenameOfUri(uri).toLowerCase();
	return name.endsWith('.html') || name.endsWith('.htm');
}

export function parentUriOf(uri: vscode.Uri): vscode.Uri {
	if (uri.scheme === 'file') {
		const parentPath = path.dirname(uri.fsPath);
		return parentPath === uri.fsPath ? uri : vscode.Uri.file(parentPath);
	}

	const parentPath = path.posix.dirname(uri.path || '/');
	return parentPath === uri.path ? uri : uri.with({ path: parentPath || '/', query: '', fragment: '' });
}

export function rootUriOf(uri: vscode.Uri): vscode.Uri {
	if (uri.scheme === 'file') {
		const parsedRoot = path.parse(uri.fsPath).root || uri.fsPath;
		return vscode.Uri.file(path.resolve(parsedRoot));
	}

	const parsedRoot = path.posix.parse(uri.path || '/').root || '/';
	return uri.with({ path: parsedRoot, query: '', fragment: '' });
}

export function localRootUriOf(rootPath: string): vscode.Uri {
	const parsedRoot = path.parse(rootPath).root || rootPath;
	return vscode.Uri.file(path.resolve(parsedRoot));
}

function formatAuthority(uri: vscode.Uri): string {
	if (!uri.authority) {
		return uri.scheme;
	}

	return uri.authority.replace(/^ssh-remote\+/, 'ssh:');
}

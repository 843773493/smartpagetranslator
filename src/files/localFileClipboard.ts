import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

const MAX_CLIPBOARD_OUTPUT_BYTES = 1024 * 1024;
const CLIPBOARD_COMMAND_TIMEOUT_MS = 2_000;

type ClipboardCommand = {
	readonly command: string;
	readonly args: readonly string[];
};

export async function readLocalFileClipboardUris(): Promise<vscode.Uri[]> {
	const text = await vscode.env.clipboard.readText();
	const textUris = await existingLocalUris(parseClipboardPaths(text));
	if (textUris.length > 0) {
		return textUris;
	}

	const nativePaths = await readNativeClipboardPaths();
	return existingLocalUris(nativePaths);
}

export function localFileClipboardFingerprint(uris: readonly vscode.Uri[]): string {
	return uris
		.map(uri => uri.toString())
		.sort((left, right) => left.localeCompare(right))
		.join('\n');
}

function parseClipboardPaths(value: string): string[] {
	const candidates: string[] = [];
	for (const rawLine of value.replace(/\0/g, '').split(/\r?\n/)) {
		const line = stripMatchingQuotes(rawLine.trim());
		if (!line || line === 'copy' || line === 'cut') {
			continue;
		}

		if (line.startsWith('file:')) {
			const uri = vscode.Uri.parse(line);
			if (uri.scheme === 'file') {
				candidates.push(uri.fsPath);
			}
			continue;
		}

		if (path.isAbsolute(line)) {
			candidates.push(line);
		}
	}

	return candidates;
}

function stripMatchingQuotes(value: string): string {
	if (value.length < 2) {
		return value;
	}

	const first = value[0];
	const last = value[value.length - 1];
	return (first === '"' && last === '"') || (first === "'" && last === "'")
		? value.slice(1, -1)
		: value;
}

async function existingLocalUris(paths: readonly string[]): Promise<vscode.Uri[]> {
	const uris: vscode.Uri[] = [];
	const seen = new Set<string>();
	for (const localPath of paths) {
		const uri = vscode.Uri.file(localPath);
		const key = uri.toString();
		if (seen.has(key)) {
			continue;
		}

		try {
			await vscode.workspace.fs.stat(uri);
			seen.add(key);
			uris.push(uri);
		} catch {
			// 剪贴板也可能包含普通文本路径；不存在的条目不应被当成待上传文件。
		}
	}

	return uris;
}

async function readNativeClipboardPaths(): Promise<string[]> {
	for (const clipboardCommand of nativeClipboardCommands()) {
		const output = await runClipboardCommand(clipboardCommand);
		if (!output) {
			continue;
		}

		const paths = parseJsonStringArray(output);
		if (paths.length > 0) {
			return paths;
		}
	}

	return [];
}

function nativeClipboardCommands(): ClipboardCommand[] {
	if (process.platform === 'win32') {
		const script = [
			'[Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
			'Add-Type -AssemblyName System.Windows.Forms',
			'@([Windows.Forms.Clipboard]::GetFileDropList()) | ConvertTo-Json -Compress'
		].join('; ');
		return [
			{ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script] },
			{ command: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', script] }
		];
	}

	if (process.platform === 'darwin') {
		// TODO: macOS 不同版本的 Finder pasteboard 类型可能变化，需要在新系统发布后复核兼容性。
		const script = [
			"ObjC.import('AppKit')",
			'const pasteboard = $.NSPasteboard.generalPasteboard',
			'const classes = $.NSArray.arrayWithObject($.NSURL)',
			'const options = $.NSDictionary.dictionaryWithObjectForKey(true, $.NSPasteboardURLReadingFileURLsOnlyKey)',
			'const urls = pasteboard.readObjectsForClassesOptions(classes, options)',
			'const paths = []',
			'if (urls) { for (let index = 0; index < urls.count; index++) { paths.push(ObjC.unwrap(urls.objectAtIndex(index).path)) } }',
			'console.log(JSON.stringify(paths))'
		].join('; ');
		return [{ command: 'osascript', args: ['-l', 'JavaScript', '-e', script] }];
	}

	// TODO: Linux 文件剪贴板没有统一接口，保留 Wayland/X11 常见工具的兼容读取。
	return [
		{ command: 'wl-paste', args: ['--no-newline', '--type', 'text/uri-list'] },
		{ command: 'xclip', args: ['-selection', 'clipboard', '-t', 'text/uri-list', '-o'] },
		{ command: 'xsel', args: ['--clipboard', '--output'] }
	];
}

function parseJsonStringArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed === 'string') {
			return [parsed];
		}
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === 'string');
		}
	} catch {
		return parseClipboardPaths(value);
	}

	return [];
}

function runClipboardCommand(clipboardCommand: ClipboardCommand): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(
			clipboardCommand.command,
			[...clipboardCommand.args],
			{
				encoding: 'utf8',
				maxBuffer: MAX_CLIPBOARD_OUTPUT_BYTES,
				timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
				windowsHide: true
			},
			(error, stdout) => resolve(error ? undefined : stdout)
		);
	});
}

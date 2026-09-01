import { randomUUID } from 'crypto';
import { zipSync } from 'fflate';
import * as vscode from 'vscode';
import { basenameOfUri, displayPathOfUri } from './rootFileUri';

type DownloadPayload = {
	readonly fileName: string;
	readonly mimeType: string;
	readonly content: Uint8Array;
};

type DownloadMessage =
	| { readonly type: 'start' }
	| { readonly type: 'chunkReceived'; readonly offset: unknown };

type PendingChunkAck = {
	readonly expectedOffset: number;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

const DOWNLOAD_CHUNK_SIZE = 256 * 1024;
const DOWNLOAD_ACK_TIMEOUT_MS = 60_000;

export function openLocalDownloadPanel(source: vscode.Uri): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(
		'smartPageTranslator.localDownload',
		`下载 ${basenameOfUri(source) || displayPathOfUri(source)}`,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: false
		}
	);
	const session = new LocalDownloadSession(panel, source);
	panel.webview.html = renderDownloadHtml(source);
	panel.webview.onDidReceiveMessage((message: unknown) => {
		void session.handleMessage(message).catch(error => session.fail(error));
	});
	panel.onDidDispose(() => session.dispose());
	return panel;
}

class LocalDownloadSession {
	private pendingAck: PendingChunkAck | undefined;
	private started = false;
	private disposed = false;
	private failed = false;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly source: vscode.Uri
	) { }

	public async handleMessage(value: unknown): Promise<void> {
		if (this.disposed || this.failed) {
			return;
		}
		const message = parseMessage(value);
		if (message.type === 'chunkReceived') {
			this.acceptChunkAck(requireNumber(message.offset, '下载分块偏移'));
			return;
		}
		if (this.started) {
			throw new Error('下载任务已经开始。');
		}
		this.started = true;
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `正在准备下载：${basenameOfUri(this.source) || displayPathOfUri(this.source)}`,
			cancellable: false
		}, async progress => {
			const payload = await buildDownloadPayload(this.source, progress);
			await this.sendPayload(payload, progress);
		});
	}

	public async fail(error: unknown): Promise<void> {
		if (this.failed || this.disposed) {
			return;
		}
		this.failed = true;
		this.rejectPendingAck(error instanceof Error ? error : new Error(String(error)));
		const detail = error instanceof Error ? error.message : String(error);
		console.error('下载失败:', error);
		await this.panel.webview.postMessage({ type: 'error', message: detail });
		void vscode.window.showErrorMessage(`下载失败：${detail}`);
	}

	public dispose(): void {
		this.disposed = true;
		this.rejectPendingAck(new Error('下载页面已关闭。'));
	}

	private async sendPayload(
		payload: DownloadPayload,
		progress: vscode.Progress<{ message?: string; increment?: number }>
	): Promise<void> {
		const ready = await this.panel.webview.postMessage({
			type: 'ready',
			fileName: payload.fileName,
			mimeType: payload.mimeType,
			size: payload.content.byteLength
		});
		if (!ready) {
			throw new Error('下载页面未响应。');
		}
		let offset = 0;
		while (offset < payload.content.byteLength) {
			const chunk = payload.content.subarray(offset, offset + DOWNLOAD_CHUNK_SIZE);
			const nextOffset = offset + chunk.byteLength;
			await this.postChunkAndWait(offset, nextOffset, Buffer.from(chunk).toString('base64'));
			offset = nextOffset;
			progress.report({
				message: `${formatBytes(offset)} / ${formatBytes(payload.content.byteLength)}`,
				increment: payload.content.byteLength > 0 ? chunk.byteLength / payload.content.byteLength * 100 : 100
			});
		}
		await this.panel.webview.postMessage({ type: 'completed' });
	}

	private async postChunkAndWait(offset: number, nextOffset: number, data: string): Promise<void> {
		if (this.pendingAck) {
			throw new Error('上一个下载分块尚未确认。');
		}
		const acknowledgement = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingAck = undefined;
				reject(new Error(`等待本地接收下载分块超时：${nextOffset}`));
			}, DOWNLOAD_ACK_TIMEOUT_MS);
			this.pendingAck = { expectedOffset: nextOffset, resolve, reject, timeout };
		});
		const delivered = await this.panel.webview.postMessage({ type: 'chunk', offset, data });
		if (!delivered) {
			this.rejectPendingAck(new Error('下载页面未接收文件分块。'));
		}
		await acknowledgement;
	}

	private acceptChunkAck(offset: number): void {
		const pending = this.pendingAck;
		if (!pending || pending.expectedOffset !== offset) {
			throw new Error(`本地下载分块确认顺序不正确：${offset}`);
		}
		clearTimeout(pending.timeout);
		this.pendingAck = undefined;
		pending.resolve();
	}

	private rejectPendingAck(error: Error): void {
		if (!this.pendingAck) {
			return;
		}
		clearTimeout(this.pendingAck.timeout);
		const reject = this.pendingAck.reject;
		this.pendingAck = undefined;
		reject(error);
	}
}

async function buildDownloadPayload(
	source: vscode.Uri,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<DownloadPayload> {
	const stat = await vscode.workspace.fs.stat(source);
	const sourceName = safeDownloadName(basenameOfUri(source) || 'download');
	if (!isDirectory(stat)) {
		progress.report({ message: sourceName });
		return {
			fileName: sourceName,
			mimeType: 'application/octet-stream',
			content: await vscode.workspace.fs.readFile(source)
		};
	}

	const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
	await collectZipEntries(source, sourceName, entries, progress);
	// TODO: workspace.fs 和 Webview 消息都没有端到端流式文件 API，超大目录目前需要在扩展内存中完成 ZIP。
	const content = zipSync(entries, { level: 6 });
	return {
		fileName: `${sourceName}.zip`,
		mimeType: 'application/zip',
		content
	};
}

async function collectZipEntries(
	directory: vscode.Uri,
	relativePath: string,
	entries: Record<string, Uint8Array>,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
	entries[`${relativePath}/`] = new Uint8Array();
	const children = await vscode.workspace.fs.readDirectory(directory);
	for (const [name] of children) {
		const child = vscode.Uri.joinPath(directory, name);
		const stat = await vscode.workspace.fs.stat(child);
		const childPath = `${relativePath}/${name}`;
		progress.report({ message: childPath });
		if (isDirectory(stat)) {
			if (isSymbolicLink(stat)) {
				// TODO: ZIP 中保留远程符号链接需要额外记录 Unix mode，当前不递归跟随目录链接以避免循环。
				throw new Error(`暂不支持下载目录符号链接：${childPath}`);
			}
			await collectZipEntries(child, childPath, entries, progress);
			continue;
		}
		entries[childPath] = await vscode.workspace.fs.readFile(child);
	}
}

function parseMessage(value: unknown): DownloadMessage {
	if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') {
		throw new Error('收到无法识别的下载消息。');
	}
	if (value.type === 'start' || value.type === 'chunkReceived') {
		return value as DownloadMessage;
	}
	throw new Error(`收到未知的下载消息：${value.type}`);
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label}必须是非负安全整数。`);
	}
	return value;
}

function isDirectory(stat: vscode.FileStat): boolean {
	return (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
}

function isSymbolicLink(stat: vscode.FileStat): boolean {
	return (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
}

function safeDownloadName(value: string): string {
	const safeName = [...value]
		.map(character => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character)
		.join('');
	return safeName || 'download';
}

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KiB`;
	}
	return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function renderDownloadHtml(source: vscode.Uri): string {
	const nonce = randomUUID().replace(/-/g, '');
	const name = escapeHtml(basenameOfUri(source) || displayPathOfUri(source));
	const path = escapeHtml(displayPathOfUri(source));
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>下载</title>
	<style>
		body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 24px; }
		main { max-width: 720px; margin: 0 auto; }
		.source { padding: 10px 12px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); word-break: break-all; }
		button, a.button { display: inline-block; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 8px 14px; cursor: pointer; text-decoration: none; }
		button:hover, a.button:hover { background: var(--vscode-button-hoverBackground); }
		button:disabled { cursor: default; opacity: .6; }
		progress { width: 100%; margin-top: 18px; }
		#status { min-height: 1.4em; color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<main>
		<h2>下载 ${name}</h2>
		<p class="source">${path}</p>
		<button id="start" type="button">下载</button>
		<a id="save" class="button" hidden>保存</a>
		<progress id="progress" value="0" max="1" hidden></progress>
		<p id="status">等待下载。</p>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const startButton = document.getElementById('start');
		const saveLink = document.getElementById('save');
		const progress = document.getElementById('progress');
		const status = document.getElementById('status');
		let parts = [];
		let received = 0;
		let objectUrl;

		startButton.addEventListener('click', () => {
			startButton.disabled = true;
			progress.hidden = false;
			status.textContent = '正在读取远程内容…';
			vscode.postMessage({ type: 'start' });
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message?.type === 'ready') {
				parts = [];
				received = 0;
				progress.max = Number(message.size) || 1;
				progress.value = 0;
				saveLink.download = String(message.fileName || 'download');
				saveLink.dataset.mimeType = String(message.mimeType || 'application/octet-stream');
				status.textContent = '正在接收：' + saveLink.download;
				return;
			}
			if (message?.type === 'chunk') {
				const bytes = base64ToBytes(String(message.data || ''));
				parts.push(bytes);
				received += bytes.byteLength;
				progress.value = received;
				vscode.postMessage({ type: 'chunkReceived', offset: received });
				return;
			}
			if (message?.type === 'completed') {
				if (objectUrl) {
					URL.revokeObjectURL(objectUrl);
				}
				const blob = new Blob(parts, { type: saveLink.dataset.mimeType });
				objectUrl = URL.createObjectURL(blob);
				saveLink.href = objectUrl;
				saveLink.hidden = false;
				status.textContent = '准备完成。如果没有自动保存，请点击“保存”。';
				progress.value = progress.max;
				saveLink.click();
				return;
			}
			if (message?.type === 'error') {
				status.textContent = '下载失败：' + String(message.message || '未知错误') + '。请关闭页面后重试。';
			}
		});

		window.addEventListener('beforeunload', () => {
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
			}
		});

		function base64ToBytes(value) {
			const binary = atob(value);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) {
				bytes[index] = binary.charCodeAt(index);
			}
			return bytes;
		}

		requestAnimationFrame(() => startButton.click());
	</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

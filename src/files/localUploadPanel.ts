import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { basenameOfUri, displayPathOfUri, parentUriOf } from './rootFileUri';

type LocalUploadPanelMode = 'select' | 'paste';

type UploadEntry = {
	readonly id: string;
	readonly relativePath: string;
	readonly size: number;
};

type UploadPlan = UploadEntry & {
	readonly target: vscode.Uri;
	readonly overwrite: boolean;
};

type ActiveUpload = {
	readonly plan: UploadPlan;
	readonly chunks: Uint8Array[];
	received: number;
};

type LocalUploadMessage =
	| { readonly type: 'prepare'; readonly entries: unknown }
	| { readonly type: 'fileStart'; readonly id: unknown }
	| { readonly type: 'chunk'; readonly id: unknown; readonly offset: unknown; readonly data: unknown }
	| { readonly type: 'fileEnd'; readonly id: unknown }
	| { readonly type: 'complete' };

const OVERWRITE = '覆盖';
const RENAME = '重命名';
const SKIP = '跳过';
const MAX_ENTRY_COUNT = 10_000;
const MAX_BASE64_CHUNK_LENGTH = 512 * 1024;

export function openLocalUploadPanel(
	destinationDirectory: vscode.Uri,
	onComplete: (uploadedUris: readonly vscode.Uri[]) => Promise<void>,
	mode: LocalUploadPanelMode = 'select'
): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel(
		'smartPageTranslator.localUpload',
		`上传到 ${basenameOfUri(destinationDirectory) || displayPathOfUri(destinationDirectory)}`,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: false
		}
	);
	const session = new LocalUploadSession(panel, destinationDirectory, onComplete);
	panel.webview.html = renderUploadHtml(destinationDirectory, mode);
	panel.webview.onDidReceiveMessage((message: unknown) => {
		void session.handleMessage(message).catch(error => session.fail(error));
	});
	panel.onDidDispose(() => session.dispose());
	return panel;
}

class LocalUploadSession {
	private readonly plans = new Map<string, UploadPlan>();
	private readonly uploadedUris: vscode.Uri[] = [];
	private activeUpload: ActiveUpload | undefined;
	private failed = false;
	private disposed = false;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly destinationDirectory: vscode.Uri,
		private readonly onComplete: (uploadedUris: readonly vscode.Uri[]) => Promise<void>
	) { }

	public async handleMessage(value: unknown): Promise<void> {
		if (this.failed || this.disposed) {
			return;
		}
		const message = parseMessage(value);
		switch (message.type) {
			case 'prepare':
				await this.prepareEntries(message.entries);
				break;
			case 'fileStart':
				this.startFile(requireString(message.id, '文件 ID'));
				break;
			case 'chunk':
				this.receiveChunk(
					requireString(message.id, '文件 ID'),
					requireNumber(message.offset, '分块偏移'),
					requireString(message.data, '文件分块')
				);
				break;
			case 'fileEnd':
				await this.finishFile(requireString(message.id, '文件 ID'));
				break;
			case 'complete':
				await this.complete();
				break;
		}
	}

	public async fail(error: unknown): Promise<void> {
		if (this.failed || this.disposed) {
			return;
		}
		this.failed = true;
		this.activeUpload = undefined;
		const detail = error instanceof Error ? error.message : String(error);
		console.error('上传失败:', error);
		await this.panel.webview.postMessage({ type: 'error', message: detail });
		void vscode.window.showErrorMessage(`上传失败：${detail}`);
	}

	public dispose(): void {
		this.disposed = true;
		this.activeUpload = undefined;
		this.plans.clear();
	}

	private async prepareEntries(value: unknown): Promise<void> {
		if (this.plans.size > 0 || this.activeUpload) {
			throw new Error('当前上传任务尚未结束。');
		}
		const entries = parseEntries(value);
		const plannedTargets = new Set<string>();
		for (const entry of entries) {
			const target = joinRelativePath(this.destinationDirectory, entry.relativePath);
			const prepared = await prepareTarget(target);
			if (prepared) {
				const targetKey = prepared.target.toString();
				if (plannedTargets.has(targetKey)) {
					throw new Error(`上传目标路径重复：${entry.relativePath}`);
				}
				plannedTargets.add(targetKey);
				this.plans.set(entry.id, { ...entry, ...prepared });
			}
		}
		await this.panel.webview.postMessage({
			type: 'accepted',
			ids: [...this.plans.keys()]
		});
	}

	private startFile(id: string): void {
		if (this.activeUpload) {
			throw new Error(`文件 '${this.activeUpload.plan.relativePath}' 尚未接收完成。`);
		}
		const plan = this.plans.get(id);
		if (!plan) {
			throw new Error(`上传任务中不存在文件 ID：${id}`);
		}
		this.activeUpload = { plan, chunks: [], received: 0 };
		void this.panel.webview.postMessage({ type: 'fileStarted', id });
	}

	private receiveChunk(id: string, offset: number, data: string): void {
		const active = this.requireActiveUpload(id);
		if (offset !== active.received) {
			throw new Error(`文件 '${active.plan.relativePath}' 的分块顺序不正确。`);
		}
		if (data.length > MAX_BASE64_CHUNK_LENGTH) {
			throw new Error(`文件 '${active.plan.relativePath}' 的单个分块过大。`);
		}
		const chunk = Uint8Array.from(Buffer.from(data, 'base64'));
		if (active.received + chunk.byteLength > active.plan.size) {
			throw new Error(`文件 '${active.plan.relativePath}' 的内容超过声明大小。`);
		}
		active.chunks.push(chunk);
		active.received += chunk.byteLength;
		void this.panel.webview.postMessage({ type: 'chunkStored', id, offset: active.received });
	}

	private async finishFile(id: string): Promise<void> {
		const active = this.requireActiveUpload(id);
		if (active.received !== active.plan.size) {
			throw new Error(`文件 '${active.plan.relativePath}' 内容不完整：${active.received}/${active.plan.size} 字节。`);
		}
		// TODO: VS Code workspace.fs 暂无流式写入 API，超大文件仍需在扩展侧合并后一次写入。
		const content = concatenateChunks(active.chunks, active.received);
		await vscode.workspace.fs.createDirectory(parentUriOf(active.plan.target));
		if (active.plan.overwrite && await pathExists(active.plan.target)) {
			await vscode.workspace.fs.delete(active.plan.target, { recursive: true, useTrash: false });
		}
		await vscode.workspace.fs.writeFile(active.plan.target, content);
		this.uploadedUris.push(active.plan.target);
		this.plans.delete(id);
		this.activeUpload = undefined;
		await this.panel.webview.postMessage({ type: 'fileStored', id });
	}

	private async complete(): Promise<void> {
		if (this.activeUpload || this.plans.size > 0) {
			throw new Error('仍有本地文件尚未上传完成。');
		}
		const completedUris = [...this.uploadedUris];
		this.uploadedUris.length = 0;
		await this.onComplete(completedUris);
		await this.panel.webview.postMessage({ type: 'completed', count: completedUris.length });
	}

	private requireActiveUpload(id: string): ActiveUpload {
		if (!this.activeUpload || this.activeUpload.plan.id !== id) {
			throw new Error(`当前没有正在接收的文件 ID：${id}`);
		}
		return this.activeUpload;
	}
}

async function prepareTarget(target: vscode.Uri): Promise<{ target: vscode.Uri; overwrite: boolean } | undefined> {
	if (!await pathExists(target)) {
		return { target, overwrite: false };
	}
	const name = basenameOfUri(target);
	const selected = await vscode.window.showWarningMessage(
		`'${name}' 已存在。`,
		{ modal: true },
		OVERWRITE,
		RENAME,
		SKIP
	);
	if (selected === OVERWRITE) {
		return { target, overwrite: true };
	}
	if (selected !== RENAME) {
		return undefined;
	}
	const newName = await vscode.window.showInputBox({
		prompt: '上传为？',
		value: name,
		validateInput: validateEntryName
	});
	if (!newName) {
		return undefined;
	}
	const renamed = vscode.Uri.joinPath(parentUriOf(target), newName);
	if (await pathExists(renamed)) {
		void vscode.window.showWarningMessage(`'${newName}' 已存在。`);
		return undefined;
	}
	return { target: renamed, overwrite: false };
}

function parseMessage(value: unknown): LocalUploadMessage {
	if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') {
		throw new Error('收到无法识别的上传消息。');
	}
	switch (value.type) {
		case 'prepare':
		case 'fileStart':
		case 'chunk':
		case 'fileEnd':
		case 'complete':
			return value as LocalUploadMessage;
		default:
			throw new Error(`收到未知的上传消息：${value.type}`);
	}
}

function parseEntries(value: unknown): UploadEntry[] {
	if (!Array.isArray(value) || value.length > MAX_ENTRY_COUNT) {
		throw new Error(`上传条目必须是数组，且不能超过 ${MAX_ENTRY_COUNT} 个。`);
	}
	const entries: UploadEntry[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			throw new Error('上传条目格式错误。');
		}
		const possible = item as { id?: unknown; relativePath?: unknown; size?: unknown };
		const id = requireString(possible.id, '文件 ID');
		if (ids.has(id)) {
			throw new Error(`上传文件 ID 重复：${id}`);
		}
		ids.add(id);
		entries.push({
			id,
			relativePath: normalizeRelativePath(requireString(possible.relativePath, '相对路径')),
			size: requireNumber(possible.size, '文件大小')
		});
	}
	return entries;
}

function normalizeRelativePath(value: string): string {
	const segments = value.replace(/\\/g, '/').split('/');
	if (segments.length === 0 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
		throw new Error(`上传路径不安全：${value}`);
	}
	return segments.join('/');
}

function joinRelativePath(root: vscode.Uri, relativePath: string): vscode.Uri {
	return vscode.Uri.joinPath(root, ...relativePath.split('/'));
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`${label}必须是非空字符串。`);
	}
	return value;
}

function requireNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label}必须是非负安全整数。`);
	}
	return value;
}

function validateEntryName(value: string): string | undefined {
	if (!value || value !== value.trim()) {
		return '名称不能为空，且前后不能包含空白字符。';
	}
	if (value.includes('/') || value.includes('\\')) {
		return '名称不能包含路径分隔符。';
	}
	return undefined;
}

function concatenateChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
	const content = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		content.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return content;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function renderUploadHtml(destinationDirectory: vscode.Uri, mode: LocalUploadPanelMode): string {
	// TODO: Chromium 的 webkitdirectory 不会返回空目录；如需保留空目录，需要单独的目录清单协议。
	const nonce = randomUUID().replace(/-/g, '');
	const initialMode = JSON.stringify(mode);
	const destination = escapeHtml(displayPathOfUri(destinationDirectory));
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>上传</title>
	<style>
		body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 24px; }
		main { max-width: 720px; margin: 0 auto; }
		.destination { padding: 10px 12px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); word-break: break-all; }
		.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0; }
		button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 8px 14px; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button:disabled { cursor: default; opacity: .6; }
		#paste-zone { border: 1px dashed var(--vscode-input-border); padding: 18px; outline: none; }
		#paste-zone:focus { border-color: var(--vscode-focusBorder); }
		progress { width: 100%; margin-top: 18px; }
		#status { min-height: 1.4em; margin-top: 10px; }
		.hint { color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<main>
		<h2>上传到远程目录</h2>
		<p class="destination">${destination}</p>
		<div class="actions">
			<button id="choose-files" type="button">选择文件</button>
			<button id="choose-folder" type="button">选择文件夹</button>
		</div>
		<input id="files" type="file" multiple hidden>
		<input id="folder" type="file" webkitdirectory multiple hidden>
		<div id="paste-zone" tabindex="0">也可以先在文件管理器复制文件，然后在这里按 Ctrl+V / Cmd+V。</div>
		<progress id="progress" value="0" max="1" hidden></progress>
		<p id="status" class="hint">等待选择文件。</p>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const mode = ${initialMode};
		const filesInput = document.getElementById('files');
		const folderInput = document.getElementById('folder');
		const pasteZone = document.getElementById('paste-zone');
		const progress = document.getElementById('progress');
		const status = document.getElementById('status');
		const buttons = Array.from(document.querySelectorAll('button'));
		const filesById = new Map();
		let pendingAck;
		let busy = false;
		const chunkSize = 256 * 1024;

		document.getElementById('choose-files').addEventListener('click', () => filesInput.click());
		document.getElementById('choose-folder').addEventListener('click', () => folderInput.click());
		filesInput.addEventListener('change', () => prepareFiles(Array.from(filesInput.files || [])));
		folderInput.addEventListener('change', () => prepareFiles(Array.from(folderInput.files || [])));
		pasteZone.addEventListener('paste', event => {
			const localFiles = Array.from(event.clipboardData?.files || []);
			if (localFiles.length > 0) {
				event.preventDefault();
				prepareFiles(localFiles);
			}
		});

		window.addEventListener('message', event => {
			const message = event.data;
			if (message?.type === 'accepted') {
				void uploadAccepted(message.ids || []);
				return;
			}
			if (message?.type === 'error') {
				status.textContent = '上传失败：' + String(message.message || '未知错误');
				status.className = '';
				busy = false;
				setButtonsEnabled(true);
				pendingAck?.reject(new Error(String(message.message || '上传失败')));
				pendingAck = undefined;
				return;
			}
			if (message?.type === 'completed') {
				status.textContent = '上传完成，共 ' + Number(message.count || 0) + ' 个文件。';
				status.className = '';
				progress.value = progress.max;
				busy = false;
				setButtonsEnabled(true);
			}
			if (pendingAck && message?.type === pendingAck.type) {
				pendingAck.resolve(message);
				pendingAck = undefined;
			}
		});

		function prepareFiles(localFiles) {
			if (busy || localFiles.length === 0) {
				return;
			}
			busy = true;
			setButtonsEnabled(false);
			filesById.clear();
			const entries = localFiles.map((file, index) => {
				const id = Date.now().toString(36) + '-' + index.toString(36);
				filesById.set(id, file);
				return { id, relativePath: file.webkitRelativePath || file.name, size: file.size };
			});
			status.textContent = '正在准备 ' + entries.length + ' 个文件…';
			progress.hidden = false;
			progress.max = entries.reduce((total, entry) => total + entry.size, 0) || 1;
			progress.value = 0;
			vscode.postMessage({ type: 'prepare', entries });
		}

		async function uploadAccepted(ids) {
			try {
				for (const id of ids) {
					const file = filesById.get(id);
					if (!file) {
						throw new Error('文件选择已失效：' + id);
					}
					status.textContent = '正在上传：' + (file.webkitRelativePath || file.name);
					await postAndWait({ type: 'fileStart', id }, 'fileStarted');
					let offset = 0;
					while (offset < file.size) {
						const buffer = await file.slice(offset, offset + chunkSize).arrayBuffer();
						const data = bytesToBase64(new Uint8Array(buffer));
						const ack = await postAndWait({ type: 'chunk', id, offset, data }, 'chunkStored');
						offset = Number(ack.offset);
						progress.value += buffer.byteLength;
					}
					await postAndWait({ type: 'fileEnd', id }, 'fileStored');
				}
				vscode.postMessage({ type: 'complete' });
			} catch (error) {
				status.textContent = '上传失败：' + String(error?.message || error);
				status.className = '';
				busy = false;
				setButtonsEnabled(true);
			}
		}

		function postAndWait(message, expectedType) {
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					if (pendingAck?.type === expectedType) {
						pendingAck = undefined;
					}
					reject(new Error('等待远程写入确认超时：' + expectedType));
				}, 60000);
				pendingAck = {
					type: expectedType,
					resolve: value => { clearTimeout(timeout); resolve(value); },
					reject: error => { clearTimeout(timeout); reject(error); }
				};
				vscode.postMessage(message);
			});
		}

		function bytesToBase64(bytes) {
			let binary = '';
			for (let offset = 0; offset < bytes.length; offset += 0x8000) {
				binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
			}
			return btoa(binary);
		}

		function setButtonsEnabled(enabled) {
			for (const button of buttons) {
				button.disabled = !enabled;
			}
		}

		if (mode === 'paste') {
			status.textContent = '请在下方区域按 Ctrl+V / Cmd+V，或点击按钮选择文件。';
			pasteZone.focus();
		} else {
			requestAnimationFrame(() => filesInput.click());
		}
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

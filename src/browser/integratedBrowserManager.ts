import { randomUUID } from 'crypto';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { basenameOfUri, displayPathOfUri, isHtmlUri, parentUriOf } from '../files/rootFileUri';

const HTML_PREVIEW_EDITOR_VIEW_TYPE = 'smartPageTranslator.htmlPreview';
const BROWSER_VIEW_TYPE = 'smartPageTranslator.browser';
const STANDALONE_BROWSER_KEY = 'standalone-browser';
const CONFIG_SECTION = 'smartPageTranslator.browser';

type BrowserMode = 'html' | 'url';
type BrowserLogLevel = 'log' | 'info' | 'warn' | 'error';

type BrowserLogEntry = {
	readonly at: string;
	readonly level: BrowserLogLevel;
	readonly source: 'browser' | 'page';
	readonly message: string;
};

type ElementSnapshot = {
	readonly tagName: string;
	readonly id?: string;
	readonly className?: string;
	readonly text?: string;
	readonly selector: string;
	readonly outerHTML?: string;
	readonly rect: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
};

type BrowserInput = {
	readonly key: string;
	readonly title: string;
	readonly mode: BrowserMode;
	readonly url: string;
	readonly html?: string;
	readonly sourceUri?: string;
};

type WebviewToExtensionMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'log'; readonly entry: BrowserLogEntry }
	| { readonly type: 'selectedElement'; readonly element: ElementSnapshot }
	| { readonly type: 'exportLogs' }
	| { readonly type: 'navigated'; readonly url: string }
	| { readonly type: 'navigateToUrl'; readonly url: string }
	| { readonly type: 'openExternal'; readonly url: string }
	| { readonly type: 'openDevTools' }
	| { readonly type: 'status'; readonly message: string; readonly severity?: 'info' | 'warning' | 'error' };

type ExtensionToWebviewMessage =
	| { readonly type: 'showToast'; readonly message: string; readonly severity?: 'info' | 'warning' | 'error' };

type BrowserRenderSettings = {
	readonly mode: BrowserMode;
	readonly url: string;
	readonly title: string;
	readonly html: string;
	readonly baseHref: string;
	readonly enablePageScripts: boolean;
	readonly focusLockEnabled: boolean;
};

type BrowserDebugPanelState = {
	readonly key: string;
	readonly title: string;
	readonly mode: BrowserMode;
	readonly url: string;
	readonly visible: boolean;
	readonly active: boolean;
};

type BrowserDebugState = {
	readonly active?: BrowserDebugPanelState;
	readonly panels: readonly BrowserDebugPanelState[];
};

export class IntegratedBrowserManager implements vscode.Disposable {
	private readonly panels = new Map<string, IntegratedBrowserView>();
	private activeView: IntegratedBrowserView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	public dispose(): void {
		for (const view of this.panels.values()) {
			view.dispose();
		}
		this.panels.clear();
		this.activeView = undefined;
	}

	public async openHtmlFile(uri: vscode.Uri): Promise<void> {
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
			void vscode.window.showWarningMessage('只能预览 HTML 文件。');
			return;
		}

		if (!isHtmlUri(uri)) {
			void vscode.window.showWarningMessage('只能预览 .html 或 .htm 文件。');
			return;
		}

		const content = await vscode.workspace.fs.readFile(uri);
		const html = new TextDecoder('utf-8').decode(content);
		this.open(this.createHtmlInput(uri, html, uri.toString()));
	}

	public async openUrl(rawUrl?: string): Promise<void> {
		const url = rawUrl || await this.askUrl();
		if (!url) {
			return;
		}

		const normalized = normalizeBrowserUrl(url);
		const html = await fetchBrowserUrlHtml(normalized);
		this.open({
			key: STANDALONE_BROWSER_KEY,
			title: `浏览 ${normalized}`,
			mode: 'url',
			url: normalized,
			html
		});
	}

	public async exportLogs(): Promise<string> {
		const view = this.requireActiveView();
		return view.exportLogs();
	}

	public async openDevTools(): Promise<void> {
		const view = this.requireActiveView();
		await view.openDevTools();
	}

	public getDebugState(): BrowserDebugState {
		const panels = Array.from(this.panels.entries()).map(([key, view]) => view.getDebugState(key));
		return {
			active: this.activeView ? this.activeView.getDebugState(findPanelKey(this.panels, this.activeView) || '') : undefined,
			panels
		};
	}

	public closeStandaloneBrowser(): void {
		this.panels.get(STANDALONE_BROWSER_KEY)?.dispose();
	}

	public attachHtmlPreviewEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		const key = `custom-editor:${document.uri.toString()}`;
		const view = IntegratedBrowserView.attach(this.context, panel, this.createHtmlInput(document.uri, document.getText(), key));
		this.trackView(key, view);
		const textDocumentChange = vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document.uri.toString() !== document.uri.toString()) {
				return;
			}
			view.show(this.createHtmlInput(document.uri, event.document.getText(), key));
		});
		view.onDispose(() => textDocumentChange.dispose());
	}

	private open(input: BrowserInput): void {
		const existing = this.panels.get(input.key);
		if (existing) {
			existing.show(input);
			this.activeView = existing;
			return;
		}

		const view = IntegratedBrowserView.create(this.context, input);
		this.trackView(input.key, view);
	}

	private trackView(key: string, view: IntegratedBrowserView): void {
		this.panels.set(key, view);
		this.activeView = view;
		view.onDispose(() => {
			this.panels.delete(key);
			if (this.activeView === view) {
				this.activeView = undefined;
			}
		});
		view.onDidBecomeActive(() => {
			this.activeView = view;
		});
	}

	private createHtmlInput(uri: vscode.Uri, html: string, key: string): BrowserInput {
		return {
			key,
			title: `预览 ${basenameOfUri(uri) || displayPathOfUri(uri)}`,
			mode: 'html',
			url: uri.toString(true),
			html,
			sourceUri: uri.toString()
		};
	}

	private requireActiveView(): IntegratedBrowserView {
		if (!this.activeView) {
			throw new Error('当前没有可操作的集成浏览器。');
		}
		return this.activeView;
	}

	private async askUrl(): Promise<string | undefined> {
		const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const homepage = configuration.get<string>('homepage', 'https://example.com');
		return vscode.window.showInputBox({
			prompt: '输入要打开的网页 URL',
			placeHolder: 'https://example.com',
			value: homepage
		});
	}

}

export function registerHtmlPreviewEditorProvider(
	context: vscode.ExtensionContext,
	browser: IntegratedBrowserManager
): void {
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			HTML_PREVIEW_EDITOR_VIEW_TYPE,
			new HtmlPreviewEditorProvider(browser),
			{
				supportsMultipleEditorsPerDocument: false,
				webviewOptions: { retainContextWhenHidden: true }
			}
		)
	);
}

class HtmlPreviewEditorProvider implements vscode.CustomTextEditorProvider {
	public constructor(private readonly browser: IntegratedBrowserManager) { }

	public resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel
	): void {
		this.browser.attachHtmlPreviewEditor(document, webviewPanel);
	}
}

export function registerIntegratedBrowserCommands(
	context: vscode.ExtensionContext,
	browser: IntegratedBrowserManager
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.browser.openUrl', async (url?: string) => {
			await browser.openUrl(url);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.browser.exportLogs', async () => {
			return browser.exportLogs();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.browser.openDevTools', async () => {
			await browser.openDevTools();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.internal.getBrowserState', () => {
			return browser.getDebugState();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.internal.closeStandaloneBrowser', () => {
			browser.closeStandaloneBrowser();
		})
	);
}

function resolveWebviewOptions(
	context: vscode.ExtensionContext,
	input: BrowserInput
): vscode.WebviewOptions {
	return {
		enableScripts: true,
		enableForms: true,
		localResourceRoots: [
			context.extensionUri,
			...(input.sourceUri ? [parentUriOf(vscode.Uri.parse(input.sourceUri))] : [])
		]
	};
}

function findPanelKey(
	panels: ReadonlyMap<string, IntegratedBrowserView>,
	target: IntegratedBrowserView
): string | undefined {
	for (const [key, view] of panels.entries()) {
		if (view === target) {
			return key;
		}
	}
	return undefined;
}

class IntegratedBrowserView implements vscode.Disposable {
	private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
	public readonly onDispose = this.onDisposeEmitter.event;

	private readonly onDidBecomeActiveEmitter = new vscode.EventEmitter<void>();
	public readonly onDidBecomeActive = this.onDidBecomeActiveEmitter.event;

	private readonly logs: BrowserLogEntry[] = [];
	private selectedElement: ElementSnapshot | undefined;
	private disposed = false;
	private currentInput: BrowserInput;

	public static create(context: vscode.ExtensionContext, input: BrowserInput): IntegratedBrowserView {
		const panel = vscode.window.createWebviewPanel(
			input.mode === 'url' ? BROWSER_VIEW_TYPE : HTML_PREVIEW_EDITOR_VIEW_TYPE,
			input.title,
			vscode.ViewColumn.Active,
			{
				...resolveWebviewOptions(context, input),
				retainContextWhenHidden: true
			}
		);
		return new IntegratedBrowserView(context, panel, input, true);
	}

	public static attach(
		context: vscode.ExtensionContext,
		panel: vscode.WebviewPanel,
		input: BrowserInput
	): IntegratedBrowserView {
		panel.webview.options = resolveWebviewOptions(context, input);
		return new IntegratedBrowserView(context, panel, input, false);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		input: BrowserInput,
		private readonly revealOnShow: boolean
	) {
		this.currentInput = input;
		this.panel.onDidDispose(() => this.dispose());
		this.panel.onDidChangeViewState(event => {
			if (event.webviewPanel.active) {
				this.onDidBecomeActiveEmitter.fire();
			}
		});
		this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
			await this.handleMessage(message);
		});
		this.show(input);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.onDisposeEmitter.fire();
		this.onDisposeEmitter.dispose();
		this.onDidBecomeActiveEmitter.dispose();
		this.panel.dispose();
	}

	public show(input: BrowserInput): void {
		this.currentInput = input;
		this.panel.title = input.title;
		this.panel.webview.options = resolveWebviewOptions(this.context, input);
		this.panel.webview.html = this.renderHtml(input);
		if (this.revealOnShow && !this.panel.visible) {
			this.panel.reveal(undefined, false);
		}
	}

	public async exportLogs(): Promise<string> {
		const clipboardText = formatLogsForCopilotClipboard(this.logs);
		await vscode.env.clipboard.writeText(clipboardText);
		this.showToast('浏览器日志已复制到剪贴板。');
		return clipboardText;
	}

	public async openDevTools(): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.webview.openDeveloperTools');
		} catch {
			// TODO: 兼容旧版 VS Code 命令名差异，当前只能退回打开整个窗口 DevTools。
			await vscode.commands.executeCommand('workbench.action.toggleDevTools');
		}
	}

	public getDebugState(key: string): BrowserDebugPanelState {
		return {
			key,
			title: this.panel.title,
			mode: this.currentInput.mode,
			url: this.currentInput.url,
			visible: this.panel.visible,
			active: this.panel.active
		};
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!isWebviewToExtensionMessage(message)) {
			return;
		}

		switch (message.type) {
			case 'ready':
				break;
			case 'log':
				this.logs.push(message.entry);
				if (this.logs.length > 1000) {
					this.logs.splice(0, this.logs.length - 1000);
				}
				break;
			case 'selectedElement':
				this.selectedElement = message.element;
				await this.copySelectedElementToClipboard(message.element);
				break;
			case 'exportLogs':
				await this.exportLogs();
				break;
			case 'navigated':
				this.panel.title = `浏览 ${message.url}`;
				this.currentInput = {
					...this.currentInput,
					title: this.panel.title,
					mode: 'url',
					url: message.url
				};
				break;
			case 'navigateToUrl':
				await this.navigateToUrl(message.url);
				break;
			case 'openExternal':
				await vscode.env.openExternal(vscode.Uri.parse(message.url));
				break;
			case 'openDevTools':
				await this.openDevTools();
				break;
			case 'status':
				this.showToast(message.message, message.severity);
				break;
		}
	}

	private async copySelectedElementToClipboard(element: ElementSnapshot): Promise<void> {
		await vscode.env.clipboard.writeText(formatElementForCopilotClipboard(element));
		this.showToast('元素内容已复制到剪贴板。');
	}

	private async navigateToUrl(rawUrl: string): Promise<void> {
		const normalized = normalizeBrowserUrl(rawUrl);
		const html = await fetchBrowserUrlHtml(normalized);
		this.show({
			...this.currentInput,
			title: `浏览 ${normalized}`,
			mode: 'url',
			url: normalized,
			html
		});
	}

	private showToast(message: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
		void this.panel.webview.postMessage({ type: 'showToast', message, severity } satisfies ExtensionToWebviewMessage);
	}

	private renderHtml(input: BrowserInput): string {
		const nonce = randomUUID();
		const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const payload: BrowserRenderSettings = {
			mode: input.mode,
			url: input.url,
			title: input.title,
			html: input.html || '',
			baseHref: input.sourceUri
				? ensureTrailingSlash(this.panel.webview.asWebviewUri(parentUriOf(vscode.Uri.parse(input.sourceUri))).toString())
				: input.mode === 'url' ? input.url : '',
			enablePageScripts: configuration.get<boolean>('enablePageScripts', true),
			focusLockEnabled: configuration.get<boolean>('focusLockIndicator.enabled', true)
		};

		if (input.mode === 'html') {
			return renderLocalHtmlPreviewDocument(input.title, payload, nonce);
		}

		const settingsJson = JSON.stringify(payload).replace(/</g, '\\u003C');
		const csp = [
			`default-src 'none'`,
			`img-src ${this.panel.webview.cspSource} data: blob: http: https:`,
			`font-src ${this.panel.webview.cspSource} data:`,
			`style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}' 'unsafe-inline'`,
			`frame-src * data: blob: ${this.panel.webview.cspSource}`,
			`connect-src *`
		].join('; ');

		const initialFrameSource = input.html ? '' : ` src="${escapeAttribute(input.url)}"`;
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escapeHtml(input.title)}</title>
	<style>${getWebviewCss()}</style>
</head>
<body>
	<script id="browser-settings" type="application/json">${settingsJson}</script>
	<header class="browser-toolbar">
		<nav class="button-group" aria-label="导航">
			<button type="button" class="icon-button" id="back-button" title="后退">‹</button>
			<button type="button" class="icon-button" id="forward-button" title="前进">›</button>
			<button type="button" class="icon-button" id="reload-button" title="刷新">↻</button>
		</nav>
		<input id="url-input" class="url-input" type="text" aria-label="URL">
		<nav class="button-group" aria-label="工具">
			<button type="button" class="text-button" id="inspect-button" title="选中页面元素">选择元素</button>
			<button type="button" class="text-button" id="logs-button" title="复制浏览器日志">日志</button>
			<button type="button" class="icon-button" id="external-button" title="在外部浏览器打开">↗</button>
			<button type="button" class="text-button" id="devtools-button" title="打开 Webview 开发人员工具">DevTools</button>
		</nav>
	</header>
	<section class="browser-info" id="browser-info" aria-live="polite" hidden></section>
	<main class="browser-content">
		<iframe id="browser-frame" title="集成浏览器页面"${initialFrameSource}></iframe>
	</main>
	<script nonce="${nonce}">${getWebviewScript()}</script>
</body>
</html>`;
	}
}

function normalizeBrowserUrl(value: string): string {
	const trimmed = value.trim();
	if (/^(https?|file|data|about):/i.test(trimmed)) {
		return trimmed;
	}
	if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(trimmed)) {
		return `http://${trimmed}`;
	}
	return `https://${trimmed}`;
}

async function fetchBrowserUrlHtml(url: string): Promise<string | undefined> {
	if (!/^https?:/i.test(url)) {
		return undefined;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);
	try {
		const response = await fetch(url, {
			redirect: 'follow',
			signal: controller.signal,
			headers: {
				'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
				'user-agent': 'Smart Page Translator VS Code Browser'
			}
		});
		const contentType = response.headers.get('content-type') || '';
		if (!isRenderableContentType(contentType)) {
			return renderRemoteMessagePage(
				url,
				`无法内嵌显示 ${contentType || 'unknown'} 内容`,
				`HTTP ${response.status} ${response.statusText}`.trim()
			);
		}

		const text = await response.text();
		if (!response.ok) {
			return renderRemoteMessagePage(
				url,
				`页面返回 HTTP ${response.status}`,
				response.statusText || text.slice(0, 300)
			);
		}
		return text;
	} catch (error) {
		return renderRemoteMessagePage(url, '网页加载失败', formatUnknownError(error));
	} finally {
		clearTimeout(timeout);
	}
}

function isRenderableContentType(contentType: string): boolean {
	return !contentType
		|| /^text\/html\b/i.test(contentType)
		|| /^application\/xhtml\+xml\b/i.test(contentType)
		|| /^text\/plain\b/i.test(contentType);
}

function renderRemoteMessagePage(url: string, title: string, detail: string): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<title>${escapeHtml(title)}</title>
</head>
<body>
	<h1>${escapeHtml(title)}</h1>
	<p>${escapeHtml(detail)}</p>
	<p><a href="${escapeAttribute(url)}">${escapeHtml(url)}</a></p>
</body>
</html>`;
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value);
}

function renderLocalHtmlPreviewDocument(
	title: string,
	settings: BrowserRenderSettings,
	nonce: string
): string {
	const preparedHtml = settings.enablePageScripts
		? stripContentSecurityPolicyMeta(settings.html)
		: stripPageScripts(stripContentSecurityPolicyMeta(settings.html));
	const base = settings.baseHref && !/<base\b/i.test(preparedHtml)
		? `<base href="${escapeAttribute(settings.baseHref)}">`
		: '';
	const runtimeSettings = {
		mode: settings.mode,
		url: settings.url,
		title: settings.title,
		baseHref: settings.baseHref,
		focusLockEnabled: settings.focusLockEnabled
	};
	const settingsJson = JSON.stringify(runtimeSettings).replace(/</g, '\\u003C');
	const headExtras = [
		base,
		`<style id="smart-page-translator-browser-style">${getLocalPreviewCss()}</style>`,
		`<script id="browser-settings" type="application/json">${settingsJson}</script>`,
		`<script id="smart-page-translator-browser-runtime" nonce="${nonce}">${getLocalPreviewScript()}</script>`
	].filter(Boolean).join('\n');

	return injectIntoHtmlHead(preparedHtml, title, headExtras);
}

function stripPageScripts(html: string): string {
	return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function stripContentSecurityPolicyMeta(html: string): string {
	// TODO: 若后续需要忠实模拟页面 CSP，需要把工具脚本拆成 webview 资源并补覆盖测试。
	return html.replace(/<meta\b[^>]*http-equiv=(["'])content-security-policy\1[^>]*>/gi, '');
}

function injectIntoHtmlHead(html: string, title: string, headExtras: string): string {
	const headPattern = /<head(\s[^>]*)?>/i;
	if (headPattern.test(html)) {
		return html.replace(headPattern, match => `${match}\n${headExtras}`);
	}

	const htmlPattern = /<html(\s[^>]*)?>/i;
	if (htmlPattern.test(html)) {
		return html.replace(htmlPattern, match => `${match}\n<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>\n${headExtras}</head>`);
	}

	// TODO: 后续如需覆盖复杂 HTML 片段，可引入 HTML parser 代替正则插入 <head>。
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<title>${escapeHtml(title)}</title>
	${headExtras}
</head>
<body>
${html}
</body>
</html>`;
}

function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
	if (!value || typeof value !== 'object' || !('type' in value)) {
		return false;
	}
	const type = (value as { readonly type: unknown }).type;
	return type === 'ready'
		|| type === 'log'
		|| type === 'selectedElement'
		|| type === 'exportLogs'
		|| type === 'navigated'
		|| type === 'navigateToUrl'
		|| type === 'openExternal'
		|| type === 'openDevTools'
		|| type === 'status';
}

function formatElementForCopilotClipboard(element: ElementSnapshot): string {
	return element.outerHTML || JSON.stringify(element, null, 2);
}

function formatLogsForCopilotClipboard(logs: readonly BrowserLogEntry[]): string {
	return JSON.stringify(logs, null, 2);
}

function getLocalPreviewCss(): string {
	return `
#smart-page-translator-browser-toolbar {
	position: fixed;
	inset: 0 0 auto 0;
	z-index: 2147483647;
	display: flex;
	align-items: center;
	gap: 6px;
	min-height: 36px;
	padding: 5px 8px;
	box-sizing: border-box;
	color: var(--vscode-editor-foreground, #d4d4d4);
	background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
	border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
}
#smart-page-translator-browser-toolbar * {
	box-sizing: border-box;
}
#smart-page-translator-browser-toolbar .browser-toolbar-group {
	display: flex;
	align-items: center;
	gap: 4px;
}
#smart-page-translator-browser-toolbar button {
	height: 26px;
	padding: 0 8px;
	color: var(--vscode-button-foreground, #ffffff);
	background: var(--vscode-button-secondaryBackground, #3a3d41);
	border: 1px solid var(--vscode-button-border, transparent);
	font: inherit;
	cursor: pointer;
	white-space: nowrap;
}
#smart-page-translator-browser-toolbar button:hover {
	background: var(--vscode-button-secondaryHoverBackground, #45494e);
}
#smart-page-translator-browser-toolbar button.active {
	background: var(--vscode-button-background, #0e639c);
}
#smart-page-translator-browser-toolbar .icon-button {
	width: 28px;
	padding: 0;
	font-size: 15px;
}
#smart-page-translator-browser-toolbar #url-input {
	flex: 1;
	min-width: 80px;
	height: 26px;
	padding: 3px 8px;
	color: var(--vscode-input-foreground, #cccccc);
	background: var(--vscode-input-background, #3c3c3c);
	border: 1px solid var(--vscode-input-border, transparent);
	font: inherit;
}
#smart-page-translator-browser-toast {
	position: fixed;
	top: 48px;
	right: 12px;
	z-index: 2147483646;
	display: none;
	max-width: min(420px, calc(100vw - 24px));
	padding: 8px 10px;
	color: var(--vscode-notifications-foreground, var(--vscode-editor-foreground, #d4d4d4));
	background: var(--vscode-notifications-background, #252526);
	border: 1px solid var(--vscode-panel-border, #3c3c3c);
	border-radius: 4px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
	font-family: var(--vscode-font-family, system-ui, sans-serif);
	font-size: var(--vscode-font-size, 13px);
	line-height: 1.4;
	overflow-wrap: anywhere;
	pointer-events: none;
}
#smart-page-translator-browser-toast[data-visible="true"] {
	display: block;
}
#smart-page-translator-browser-toast[data-severity="warning"] {
	border-color: var(--vscode-editorWarning-foreground, #cca700);
}
#smart-page-translator-browser-toast[data-severity="error"] {
	border-color: var(--vscode-editorError-foreground, #f14c4c);
}
html {
	scroll-padding-top: 44px !important;
}
body {
	padding-top: 44px !important;
}
.spt-browser-hover-outline {
	outline: 2px solid var(--vscode-focusBorder, #007fd4) !important;
	outline-offset: 2px !important;
}`;
}

function getLocalPreviewScript(): string {
	return `
const vscode = acquireVsCodeApi();
const settings = JSON.parse(document.getElementById('browser-settings')?.textContent || '{}');
let inspectMode = false;
let hoveredElement;
let toastTimer;

patchConsole();
window.addEventListener('error', event => {
	recordLog('error', event.message, 'page');
});
window.addEventListener('unhandledrejection', event => {
	recordLog('error', 'Unhandled rejection: ' + stringifyValue(event.reason), 'page');
});
window.addEventListener('message', event => {
	const data = event.data;
	if (!data || typeof data.type !== 'string') {
		return;
	}
	if (data.type === 'setInspectMode') {
		setInspectMode(Boolean(data.enabled));
	} else if (data.type === 'showToast') {
		showToast(data.message, data.severity);
	}
});

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializePreview, { once: true });
} else {
	initializePreview();
}

function initializePreview() {
	installToolbar();
	installToast();
	document.addEventListener('mousemove', handleInspectMove, true);
	document.addEventListener('click', handleInspectClick, true);
	vscode.postMessage({ type: 'ready' });
}

function installToolbar() {
	if (document.getElementById('smart-page-translator-browser-toolbar')) {
		return;
	}
	const toolbar = document.createElement('header');
	toolbar.id = 'smart-page-translator-browser-toolbar';
	toolbar.innerHTML = [
		'<nav class="browser-toolbar-group" aria-label="导航">',
		'<button type="button" class="icon-button" id="reload-button" title="刷新">↻</button>',
		'</nav>',
		'<input id="url-input" type="text" aria-label="URL" readonly>',
		'<nav class="browser-toolbar-group" aria-label="工具">',
		'<button type="button" id="inspect-button" title="选中页面元素">选择元素</button>',
		'<button type="button" id="logs-button" title="复制浏览器日志">日志</button>',
		'<button type="button" class="icon-button" id="external-button" title="在外部浏览器打开">↗</button>',
		'<button type="button" id="devtools-button" title="打开 Webview 开发人员工具">DevTools</button>',
		'</nav>'
	].join('');
	document.body.prepend(toolbar);

	document.getElementById('url-input').value = settings.url || location.href;
	document.getElementById('reload-button').addEventListener('click', () => location.reload());
	document.getElementById('inspect-button').addEventListener('click', () => setInspectMode(!inspectMode));
	document.getElementById('logs-button').addEventListener('click', () => vscode.postMessage({ type: 'exportLogs' }));
	document.getElementById('external-button').addEventListener('click', () => {
		if (settings.url) {
			vscode.postMessage({ type: 'openExternal', url: settings.url });
		}
	});
	document.getElementById('devtools-button').addEventListener('click', () => vscode.postMessage({ type: 'openDevTools' }));
}

function installToast() {
	const toast = document.createElement('section');
	toast.id = 'smart-page-translator-browser-toast';
	toast.setAttribute('aria-live', 'polite');
	document.body.appendChild(toast);
}

function patchConsole() {
	['log', 'info', 'warn', 'error'].forEach(level => {
		const original = console[level];
		console[level] = function patchedConsole(...values) {
			recordLog(level, values.map(stringifyValue).join(' '), 'page');
			original.apply(console, values);
		};
	});
}

function handleInspectMove(event) {
	if (!inspectMode || !(event.target instanceof Element) || isPreviewChrome(event.target)) {
		return;
	}
	clearHover();
	hoveredElement = event.target;
	hoveredElement.classList.add('spt-browser-hover-outline');
}

function handleInspectClick(event) {
	if (!inspectMode || !(event.target instanceof Element) || isPreviewChrome(event.target)) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const element = describeElement(event.target);
	vscode.postMessage({ type: 'selectedElement', element });
}

function setInspectMode(enabled) {
	inspectMode = enabled;
	document.getElementById('inspect-button')?.classList.toggle('active', enabled);
	if (!enabled) {
		clearHover();
	}
}

function clearHover() {
	if (!hoveredElement) {
		return;
	}
	hoveredElement.classList.remove('spt-browser-hover-outline');
	hoveredElement = undefined;
}

function describeElement(element) {
	const rect = element.getBoundingClientRect();
	const path = [];
	let current = element;
	while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
		let part = current.tagName.toLowerCase();
		if (current.id) {
			part += '#' + CSS.escape(current.id);
			path.unshift(part);
			break;
		}
		const classNames = String(current.className || '').split(/\\s+/).filter(Boolean).slice(0, 2);
		if (classNames.length) {
			part += '.' + classNames.map(name => CSS.escape(name)).join('.');
		}
		path.unshift(part);
		current = current.parentElement;
	}
	return {
		tagName: element.tagName.toLowerCase(),
		id: element.id || undefined,
		className: typeof element.className === 'string' ? element.className : undefined,
		text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
		outerHTML: element.outerHTML || undefined,
		selector: path.join(' > '),
		rect: {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: Math.round(rect.width),
			height: Math.round(rect.height)
		}
	};
}

function recordLog(level, message, source) {
	const normalized = level === 'info' || level === 'warn' || level === 'error' ? level : 'log';
	vscode.postMessage({
		type: 'log',
		entry: {
			at: new Date().toISOString(),
			level: normalized,
			source,
			message: String(message || '')
		}
	});
}

function notify(message, severity) {
	showToast(message, severity);
}

function showToast(message, severity) {
	const toast = document.getElementById('smart-page-translator-browser-toast');
	if (!toast) {
		return;
	}
	toast.textContent = String(message || '');
	toast.dataset.severity = severity || 'info';
	toast.dataset.visible = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		delete toast.dataset.visible;
	}, 3000);
}

function stringifyValue(value) {
	if (value instanceof Error) {
		return value.stack || value.message;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isPreviewChrome(element) {
	return Boolean(element.closest('#smart-page-translator-browser-toolbar,#smart-page-translator-browser-toast'));
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}`;
}

function getWebviewCss(): string {
	return `
* {
	box-sizing: border-box;
}
html,
body {
	width: 100%;
	height: 100%;
	margin: 0;
	padding: 0;
	overflow: hidden;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
}
body {
	display: grid;
	position: relative;
	grid-template-rows: auto 1fr;
}
.browser-toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
	min-height: 36px;
	padding: 5px 8px;
	border-bottom: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editorGroupHeader-tabsBackground);
}
.button-group {
	display: flex;
	align-items: center;
	gap: 4px;
}
.url-input {
	flex: 1;
	min-width: 80px;
	height: 26px;
	padding: 3px 8px;
	color: var(--vscode-input-foreground);
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, transparent);
}
button {
	height: 26px;
	color: var(--vscode-button-foreground);
	background: var(--vscode-button-secondaryBackground);
	border: 1px solid var(--vscode-button-border, transparent);
	cursor: pointer;
}
button:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.icon-button {
	width: 28px;
	padding: 0;
	font-size: 16px;
}
.text-button {
	padding: 0 8px;
	white-space: nowrap;
}
.text-button.active {
	background: var(--vscode-button-background);
}
.browser-info {
	position: absolute;
	top: 48px;
	right: 12px;
	z-index: 10;
	max-width: min(420px, calc(100vw - 24px));
	padding: 8px 10px;
	color: var(--vscode-notifications-foreground, var(--vscode-editor-foreground));
	background: var(--vscode-notifications-background);
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
	line-height: 1.4;
	overflow-wrap: anywhere;
	pointer-events: none;
}
.browser-info[data-visible="true"] {
	display: block;
}
.browser-info[data-severity="warning"] {
	border-color: var(--vscode-editorWarning-foreground, #cca700);
}
.browser-info[data-severity="error"] {
	border-color: var(--vscode-editorError-foreground, #f14c4c);
}
.browser-content {
	position: relative;
	min-height: 0;
}
#browser-frame {
	width: 100%;
	height: 100%;
	border: 0;
	background: #ffffff;
}
body.focus-lock-enabled .browser-content:focus-within::after {
	content: "Focus Lock";
	position: absolute;
	right: 10px;
	bottom: 10px;
	padding: 2px 6px;
	color: var(--vscode-editor-foreground);
	background: var(--vscode-notifications-background);
	border: 1px solid var(--vscode-panel-border);
}`;
}

function getWebviewScript(): string {
	return `
const vscode = acquireVsCodeApi();
const settings = JSON.parse(document.getElementById('browser-settings').textContent || '{}');
const frame = document.getElementById('browser-frame');
const input = document.getElementById('url-input');
const info = document.getElementById('browser-info');
const inspectButton = document.getElementById('inspect-button');
const logsButton = document.getElementById('logs-button');
const externalButton = document.getElementById('external-button');
const devtoolsButton = document.getElementById('devtools-button');
const backButton = document.getElementById('back-button');
const forwardButton = document.getElementById('forward-button');
const reloadButton = document.getElementById('reload-button');
let currentUrl = settings.url || '';
let inspectMode = false;
let toastTimer;

document.body.classList.toggle('focus-lock-enabled', Boolean(settings.focusLockEnabled));
input.value = currentUrl;
renderCurrentInput();
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', event => {
	const data = event.data;
	if (data && data.channel === 'smartPageTranslator.browser') {
		handlePageBridgeMessage(data.payload);
		return;
	}
	if (!data || typeof data.type !== 'string') {
		return;
	}
	if (data.type === 'setInspectMode') {
		setInspectMode(Boolean(data.enabled));
	} else if (data.type === 'showToast') {
		showToast(data.message, data.severity);
	}
});

input.addEventListener('change', navigateToInputValue);
input.addEventListener('keydown', event => {
	if (event.key === 'Enter') {
		event.preventDefault();
		navigateToInputValue();
		input.blur();
	}
});
function navigateToInputValue() {
	currentUrl = normalizeUrl(input.value);
	settings.mode = 'url';
	settings.url = currentUrl;
	input.value = currentUrl;
	document.title = '浏览 ' + currentUrl;
	vscode.postMessage({ type: 'navigateToUrl', url: currentUrl });
}
backButton.addEventListener('click', () => navigateHistory(-1));
forwardButton.addEventListener('click', () => navigateHistory(1));
reloadButton.addEventListener('click', () => renderCurrentInput());
inspectButton.addEventListener('click', () => setInspectMode(!inspectMode));
logsButton.addEventListener('click', () => vscode.postMessage({ type: 'exportLogs' }));
externalButton.addEventListener('click', () => {
	if (currentUrl) {
		vscode.postMessage({ type: 'openExternal', url: currentUrl });
	}
});
devtoolsButton.addEventListener('click', () => vscode.postMessage({ type: 'openDevTools' }));

function renderCurrentInput() {
	if (settings.mode === 'html') {
		frame.removeAttribute('src');
		frame.srcdoc = buildInstrumentedHtml(settings.html || '');
		return;
	}

	const normalized = normalizeUrl(currentUrl);
	currentUrl = normalized;
	input.value = normalized;
	document.title = '浏览 ' + normalized;
	vscode.postMessage({ type: 'navigated', url: normalized });
	if (settings.html) {
		frame.removeAttribute('src');
		frame.srcdoc = buildInstrumentedHtml(stripContentSecurityPolicyMeta(settings.html || ''));
		return;
	}
	frame.removeAttribute('srcdoc');
	frame.src = normalized;
}

function stripContentSecurityPolicyMeta(source) {
	return String(source || '').replace(/<meta\\b[^>]*http-equiv=(["'])content-security-policy\\1[^>]*>/gi, '');
}

function normalizeUrl(value) {
	const raw = String(value || '').trim();
	if (/^(https?|file|data|about):/i.test(raw)) {
		return raw;
	}
	if (/^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:|\\/|$)/i.test(raw)) {
		return 'http://' + raw;
	}
	return 'https://' + raw;
}

function navigateHistory(delta) {
	try {
		if (delta < 0) {
			frame.contentWindow.history.back();
		} else {
			frame.contentWindow.history.forward();
		}
	} catch {
		notify('当前页面跨域，无法控制 iframe 历史。', 'warning');
	}
}

function buildInstrumentedHtml(source) {
	const base = settings.baseHref && !/<base\\b/i.test(source)
		? '<base href="' + escapeAttribute(settings.baseHref) + '">'
		: '';
	const bridge = '<script>' + getBridgeSource() + '<\\\\/script>';
	let html = settings.enablePageScripts
		? source
		: source.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
	const headPattern = /<head(\\s[^>]*)?>/i;
	if (headPattern.test(html)) {
		return html.replace(headPattern, match => match + '\\n' + base + '\\n' + bridge);
	}
	const htmlPattern = /<html(\\s[^>]*)?>/i;
	if (htmlPattern.test(html)) {
		return html.replace(htmlPattern, match => match + '\\n<head>' + base + '\\n' + bridge + '</head>');
	}
	return '<!doctype html><html><head><meta charset="UTF-8">' + base + bridge + '</head><body>' + html + '</body></html>';
}

function getBridgeSource() {
	return '(' + function bridge() {
		const channel = 'smartPageTranslator.browser';
		const send = (payload) => window.parent.postMessage({ channel, payload }, '*');
		const stringify = (value) => {
			if (value instanceof Error) {
				return value.stack || value.message;
			}
			if (typeof value === 'string') {
				return value;
			}
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		};
		['log', 'info', 'warn', 'error'].forEach((level) => {
			const original = console[level];
			console[level] = function patchedConsole(...values) {
				send({ type: 'pageLog', level, values: values.map(stringify) });
				original.apply(console, values);
			};
		});
		window.addEventListener('error', event => {
			send({ type: 'pageLog', level: 'error', values: [event.message] });
		});
		window.addEventListener('unhandledrejection', event => {
			send({ type: 'pageLog', level: 'error', values: ['Unhandled rejection: ' + stringify(event.reason)] });
		});

		let inspectMode = false;
		let hovered;
		const style = document.createElement('style');
		style.textContent = '.spt-browser-hover-outline{outline:2px solid #4da3ff !important; outline-offset:2px !important;}';
		document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
		const describeElement = (element) => {
			const rect = element.getBoundingClientRect();
			const path = [];
			let current = element;
			while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
				let part = current.tagName.toLowerCase();
				if (current.id) {
					part += '#' + CSS.escape(current.id);
					path.unshift(part);
					break;
				}
				const classNames = String(current.className || '').split(/\\s+/).filter(Boolean).slice(0, 2);
				if (classNames.length) {
					part += '.' + classNames.map(name => CSS.escape(name)).join('.');
				}
				path.unshift(part);
				current = current.parentElement;
			}
				return {
					tagName: element.tagName.toLowerCase(),
					id: element.id || undefined,
					className: typeof element.className === 'string' ? element.className : undefined,
					text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
					outerHTML: element.outerHTML || undefined,
					selector: path.join(' > '),
					rect: {
					x: Math.round(rect.x),
					y: Math.round(rect.y),
					width: Math.round(rect.width),
					height: Math.round(rect.height)
				}
			};
		};
		const clearHover = () => {
			if (hovered) {
				hovered.classList.remove('spt-browser-hover-outline');
				hovered = undefined;
			}
		};
		document.addEventListener('mousemove', event => {
			if (!inspectMode || !(event.target instanceof Element)) {
				return;
			}
			clearHover();
			hovered = event.target;
			hovered.classList.add('spt-browser-hover-outline');
		}, true);
		document.addEventListener('click', event => {
			if (!inspectMode || !(event.target instanceof Element)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			send({ type: 'selectedElement', element: describeElement(event.target) });
		}, true);
		window.addEventListener('message', event => {
			if (!event.data || event.data.channel !== 'smartPageTranslator.browser.control') {
				return;
			}
			if (event.data.type === 'setInspectMode') {
				inspectMode = Boolean(event.data.enabled);
				if (!inspectMode) {
					clearHover();
				}
			}
		});
	}.toString() + ')();';
}

function handlePageBridgeMessage(payload) {
	if (!payload || typeof payload.type !== 'string') {
		return;
	}
	if (payload.type === 'pageLog') {
		const message = Array.isArray(payload.values) ? payload.values.join(' ') : '';
		recordLog(payload.level || 'log', message, 'page');
		return;
	}
	if (payload.type === 'selectedElement') {
		vscode.postMessage({ type: 'selectedElement', element: payload.element });
	}
}

function setInspectMode(enabled) {
	inspectMode = enabled;
	inspectButton.classList.toggle('active', enabled);
	try {
		frame.contentWindow.postMessage({
			channel: 'smartPageTranslator.browser.control',
			type: 'setInspectMode',
			enabled
		}, '*');
	} catch {
		notify('当前页面跨域，无法启用元素选择。', 'warning');
	}
}

function recordLog(level, message, source) {
	const entry = {
		at: new Date().toISOString(),
		level: level === 'info' || level === 'warn' || level === 'error' ? level : 'log',
		source,
		message: String(message || '')
	};
	vscode.postMessage({ type: 'log', entry });
}

function notify(message, severity) {
	showToast(message, severity);
}

function showToast(message, severity) {
	if (!info) {
		return;
	}
	info.textContent = message;
	info.hidden = false;
	info.dataset.severity = severity || 'info';
	info.dataset.visible = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		delete info.dataset.visible;
		info.hidden = true;
	}, 3000);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function escapeAttribute(value) {
	return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}`;
}

import { randomUUID } from 'crypto';
import * as http from 'http';
import { TextDecoder } from 'util';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import WebSocket, { WebSocketServer } from 'ws';
import * as vscode from 'vscode';
import { basenameOfUri, displayPathOfUri, isHtmlUri, parentUriOf } from '../files/rootFileUri';

const HTML_PREVIEW_EDITOR_VIEW_TYPE = 'smartPageTranslator.htmlPreview';
const BROWSER_VIEW_TYPE = 'smartPageTranslator.browser';
const STANDALONE_BROWSER_KEY = 'standalone-browser';
const PROXY_PAGE_TOKEN_QUERY = '__smartPageTranslatorProxyToken';
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

type BrowserSelectionOptions = {
	readonly copyToClipboard?: boolean;
};

type StoredProxyCookie = {
	readonly name: string;
	readonly value: string;
	readonly domain: string;
	readonly path: string;
	readonly secure: boolean;
	readonly hostOnly: boolean;
	readonly expiresAt?: number;
};

type BrowserInput = {
	readonly key: string;
	readonly title: string;
	readonly mode: BrowserMode;
	readonly url: string;
	readonly html?: string;
	readonly sourceUri?: string;
	readonly proxyUrl?: string;
	readonly baseHref?: string;
	readonly resourceBaseUrl?: string;
};

type WebviewToExtensionMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'log'; readonly entry: BrowserLogEntry }
	| { readonly type: 'selectedElement'; readonly element: ElementSnapshot; readonly copyToClipboard?: boolean }
	| { readonly type: 'exportLogs' }
	| { readonly type: 'navigated'; readonly url: string }
	| { readonly type: 'navigateToUrl'; readonly url: string }
	| { readonly type: 'openExternal'; readonly url: string }
	| { readonly type: 'openDevTools' }
	| { readonly type: 'status'; readonly message: string; readonly severity?: 'info' | 'warning' | 'error' };

type ExtensionToWebviewMessage =
	| { readonly type: 'showToast'; readonly message: string; readonly severity?: 'info' | 'warning' | 'error' }
	| { readonly type: 'setInspectMode'; readonly enabled: boolean }
	| { readonly type: 'selectElementBySelector'; readonly selector: string; readonly copyToClipboard?: boolean }
	| {
		readonly type: 'loadUrl';
		readonly url: string;
		readonly title: string;
		readonly proxyUrl?: string;
	};

type BrowserRenderSettings = {
	readonly mode: BrowserMode;
	readonly url: string;
	readonly title: string;
	readonly html: string;
	readonly baseHref: string;
	readonly proxyUrl?: string;
	readonly resourceBaseUrl?: string;
	readonly enablePageScripts: boolean;
	readonly focusLockEnabled: boolean;
};

type BrowserDebugPanelState = {
	readonly key: string;
	readonly title: string;
	readonly mode: BrowserMode;
	readonly url: string;
	readonly webviewUrl?: string;
	readonly proxyUrl?: string;
	readonly selectedElement?: ElementSnapshot;
	readonly lastPostMessage?: {
		readonly type: string;
		readonly delivered?: boolean;
	};
	readonly visible: boolean;
	readonly active: boolean;
};

type BrowserDebugState = {
	readonly active?: BrowserDebugPanelState;
	readonly panels: readonly BrowserDebugPanelState[];
	readonly remoteName?: string;
	readonly extensionKind: 'ui' | 'workspace' | 'unknown';
};

export class IntegratedBrowserManager implements vscode.Disposable {
	private readonly urlProxy: BrowserUrlProxy;
	private readonly panels = new Map<string, IntegratedBrowserView>();
	private activeView: IntegratedBrowserView | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.urlProxy = new BrowserUrlProxy(context.extension.extensionKind);
	}

	public dispose(): void {
		for (const view of this.panels.values()) {
			view.dispose();
		}
		this.panels.clear();
		this.activeView = undefined;
		this.urlProxy.dispose();
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
		let proxied: Awaited<ReturnType<BrowserUrlProxy['createProxiedHtml']>> | undefined;
		if (isHttpUrl(normalized)) {
			try {
				proxied = await this.urlProxy.createProxiedHtml(normalized);
			} catch (error) {
				const message = formatUnknownError(error);
				void vscode.window.showErrorMessage(`网页加载失败：${message}`);
				this.open({
					key: STANDALONE_BROWSER_KEY,
					title: `加载失败 ${normalized}`,
					mode: 'url',
					url: normalized,
					html: renderBrowserLoadErrorDocument(normalized, message),
					baseHref: normalized
				});
				return;
			}
		}
		this.open({
			key: STANDALONE_BROWSER_KEY,
			title: `浏览 ${proxied?.resolvedUrl || normalized}`,
			mode: 'url',
			url: proxied?.resolvedUrl || normalized,
			html: proxied?.html,
			proxyUrl: proxied?.pageUrl,
			baseHref: proxied?.resolvedUrl,
			resourceBaseUrl: proxied?.resourceBaseUrl
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

	public setInspectMode(enabled: boolean): void {
		const view = this.requireActiveView();
		view.setInspectMode(enabled);
	}

	public selectElementBySelector(selector: string, options?: BrowserSelectionOptions): void {
		const view = this.requireActiveView();
		view.selectElementBySelector(selector, options);
	}

	public getDebugState(): BrowserDebugState {
		const panels = Array.from(this.panels.entries()).map(([key, view]) => view.getDebugState(key));
		return {
			active: this.activeView ? this.activeView.getDebugState(findPanelKey(this.panels, this.activeView) || '') : undefined,
			panels,
			remoteName: vscode.env.remoteName,
			extensionKind: formatExtensionKind(this.context.extension.extensionKind)
		};
	}

	public closeStandaloneBrowser(): void {
		this.panels.get(STANDALONE_BROWSER_KEY)?.dispose();
	}

	public attachHtmlPreviewEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		const key = `custom-editor:${document.uri.toString()}`;
		const view = IntegratedBrowserView.attach(this.context, panel, this.createHtmlInput(document.uri, document.getText(), key), this.urlProxy);
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
			if (input.key === STANDALONE_BROWSER_KEY && input.mode === 'url') {
				existing.dispose();
			} else {
				existing.show(input);
				this.activeView = existing;
				return;
			}
		}

		const view = IntegratedBrowserView.create(this.context, input, this.urlProxy);
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

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.internal.setBrowserInspectMode', (enabled = true) => {
			browser.setInspectMode(Boolean(enabled));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('smartPageTranslator.internal.selectBrowserElementBySelector', (selector: string, options?: BrowserSelectionOptions) => {
			if (typeof selector !== 'string' || !selector.trim()) {
				throw new Error('selectBrowserElementBySelector 需要非空 CSS selector。');
			}
			browser.selectElementBySelector(selector, options);
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

function formatExtensionKind(kind: vscode.ExtensionKind): 'ui' | 'workspace' | 'unknown' {
	if (kind === vscode.ExtensionKind.UI) {
		return 'ui';
	}
	if (kind === vscode.ExtensionKind.Workspace) {
		return 'workspace';
	}
	return 'unknown';
}

class BrowserUrlProxy implements vscode.Disposable {
	private readonly pageTargets = new Map<string, string>();
	private readonly cookieJars = new Map<string, Map<string, StoredProxyCookie>>();
	private server: http.Server | undefined;
	private webSocketServer: WebSocketServer | undefined;
	private port: number | undefined;
	private startPromise: Promise<number> | undefined;
	private lastPageToken: string | undefined;

	constructor(private readonly extensionKind: vscode.ExtensionKind) { }

	public async createProxiedHtml(targetUrl: string): Promise<{
		readonly pageUrl: string;
		readonly html: string;
		readonly resolvedUrl: string;
		readonly resourceBaseUrl: string;
	}> {
		const handle = await this.createPageHandle(targetUrl);
		let upstream = await fetchBrowserDocument(targetUrl, this.createCookieHeader(handle.token, targetUrl));
		this.storeResponseCookies(handle.token, upstream, targetUrl);
		let contentType = upstream.headers.get('content-type') || '';
		let resolvedUrl = upstream.url || targetUrl;
		if (!contentType.toLowerCase().includes('text/html')) {
			const body = await upstream.text();
			return {
				pageUrl: handle.pageUrl,
				html: renderNonHtmlProxyDocument(resolvedUrl, contentType, body),
				resolvedUrl,
				resourceBaseUrl: handle.resourceBaseUrl
			};
		}

		let html = await upstream.text();
		const clientRedirect = resolveInitialClientRedirect(html, resolvedUrl);
		if (clientRedirect) {
			upstream = await fetchBrowserDocument(clientRedirect, this.createCookieHeader(handle.token, clientRedirect));
			this.storeResponseCookies(handle.token, upstream, clientRedirect);
			contentType = upstream.headers.get('content-type') || '';
			resolvedUrl = upstream.url || clientRedirect;
			html = await upstream.text();
		}
		return {
			pageUrl: handle.pageUrl,
			html: rewriteProxiedHtmlResourceUrls(stripContentSecurityPolicyMeta(html), resolvedUrl, handle.resourceBaseUrl),
			resolvedUrl,
			resourceBaseUrl: handle.resourceBaseUrl
		};
	}

	public async createPageUrl(targetUrl: string): Promise<string> {
		return (await this.createPageHandle(targetUrl)).pageUrl;
	}

	public dispose(): void {
		this.pageTargets.clear();
		this.cookieJars.clear();
		this.lastPageToken = undefined;
		if (this.server) {
			this.webSocketServer?.close();
			this.webSocketServer = undefined;
			this.server.close();
			this.server = undefined;
			this.port = undefined;
			this.startPromise = undefined;
		}
	}

	private async createPageHandle(targetUrl: string): Promise<{
		readonly token: string;
		readonly pageUrl: string;
		readonly resourceBaseUrl: string;
	}> {
		const port = await this.ensureStarted();
		const token = randomUUID();
		this.pageTargets.set(token, targetUrl);
		this.cookieJars.set(token, new Map());
		this.lastPageToken = token;
		const visibleTarget = new URL(targetUrl);
		const proxyUrl = new URL(`http://127.0.0.1:${port}${visibleTarget.pathname}${visibleTarget.search}`);
		proxyUrl.searchParams.set(PROXY_PAGE_TOKEN_QUERY, token);
		proxyUrl.hash = visibleTarget.hash;
		return {
			token,
			pageUrl: await this.toWebviewReachableUri(vscode.Uri.parse(proxyUrl.toString())),
			resourceBaseUrl: await this.createExternalResourceBaseUrl(token)
		};
	}

	private async ensureStarted(): Promise<number> {
		if (this.port) {
			return this.port;
		}
		if (this.startPromise) {
			return this.startPromise;
		}

		this.server = http.createServer((request, response) => {
			void this.handleRequest(request, response);
		});
		this.webSocketServer = new WebSocketServer({ noServer: true });
		this.server.on('upgrade', (request, socket, head) => {
			void this.handleWebSocketUpgrade(request, socket, head);
		});

		this.startPromise = new Promise<number>((resolve, reject) => {
			const server = this.server;
			if (!server) {
				reject(new Error('浏览器代理服务未创建。'));
				return;
			}

			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				server.off('error', reject);
				const address = server.address();
				if (!address || typeof address === 'string') {
					reject(new Error('浏览器代理服务未获取到本地端口。'));
					return;
				}
				this.port = address.port;
				resolve(address.port);
			});
		});

		return this.startPromise;
	}

	private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		try {
			const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
			if (request.method === 'OPTIONS') {
				writeProxyResponse(response, 204, corsHeaders(), undefined);
				return;
			}

			const queryPageToken = requestUrl.searchParams.get(PROXY_PAGE_TOKEN_QUERY);
			if (queryPageToken) {
				await this.handlePageRequest(queryPageToken, request, response);
				return;
			}

			const pageMatch = requestUrl.pathname.match(/^\/page\/([^/]+)$/);
			if (pageMatch) {
				await this.handlePageRequest(pageMatch[1], request, response);
				return;
			}

			const resourceMatch = requestUrl.pathname.match(/^\/resource\/([^/]+)$/);
			if (resourceMatch) {
				await this.handleResourceRequest(resourceMatch[1], requestUrl, request, response);
				return;
			}

			const implicitToken = this.resolveTokenFromReferer(request.headers.referer) || this.lastPageToken;
			if (implicitToken) {
				await this.handleImplicitResourceRequest(implicitToken, requestUrl, request, response);
				return;
			}

			writeProxyResponse(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');
		} catch (error) {
			writeProxyResponse(response, 502, { 'content-type': 'text/plain; charset=utf-8' }, `Proxy error: ${formatUnknownError(error)}`);
		}
	}

	private async handleWebSocketUpgrade(
		request: http.IncomingMessage,
		socket: import('stream').Duplex,
		head: Buffer
	): Promise<void> {
		const webSocketServer = this.webSocketServer;
		if (!webSocketServer) {
			rejectWebSocketUpgrade(socket, 503, 'WebSocket proxy is unavailable');
			return;
		}

		try {
			const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
			const token = requestUrl.searchParams.get(PROXY_PAGE_TOKEN_QUERY) || this.lastPageToken;
			const pageTarget = token ? this.pageTargets.get(token) : undefined;
			if (!token || !pageTarget) {
				rejectWebSocketUpgrade(socket, 404, 'Unknown proxy page');
				return;
			}

			const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, pageTarget);
			upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
			upstreamUrl.searchParams.delete(PROXY_PAGE_TOKEN_QUERY);
			const protocols = parseWebSocketProtocols(request.headers['sec-websocket-protocol']);
			const upstream = new WebSocket(upstreamUrl, protocols, {
				headers: {
					origin: new URL(pageTarget).origin,
					'user-agent': 'SmartPageTranslator/1.0 VSCodeWebviewProxy',
					...createCookieRequestHeader(this.createCookieHeader(token, upstreamUrl.toString()))
				},
				handshakeTimeout: 15_000
			});

			const failBeforeUpgrade = (error: Error): void => {
				rejectWebSocketUpgrade(socket, 502, `WebSocket upstream error: ${error.message}`);
			};
			upstream.once('error', failBeforeUpgrade);
			upstream.once('open', () => {
				upstream.off('error', failBeforeUpgrade);
				webSocketServer.handleUpgrade(request, socket, head, downstream => {
					bridgeWebSockets(downstream, upstream);
				});
			});
		} catch (error) {
			rejectWebSocketUpgrade(socket, 502, `WebSocket proxy error: ${formatUnknownError(error)}`);
		}
	}

	private async handlePageRequest(token: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		const targetUrl = this.pageTargets.get(token);
		if (!targetUrl) {
			writeProxyResponse(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Unknown proxy page');
			return;
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			writeProxyResponse(response, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed');
			return;
		}
		this.lastPageToken = token;

		const upstream = await fetch(targetUrl, {
			method: 'GET',
			redirect: 'follow',
			headers: {
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'user-agent': 'SmartPageTranslator/1.0 VSCodeWebviewProxy',
				...createCookieRequestHeader(this.createCookieHeader(token, targetUrl))
			}
		});
		this.storeResponseCookies(token, upstream, upstream.url || targetUrl);
		const contentType = upstream.headers.get('content-type') || '';
		if (!contentType.toLowerCase().includes('text/html')) {
			await writeUpstreamResponse(response, upstream, request.method === 'HEAD');
			return;
		}

		const html = await upstream.text();
		const resourceBaseUrl = await this.createExternalResourceBaseUrl(token);
		const rendered = renderProxiedBrowserDocument(html, upstream.url || targetUrl, resourceBaseUrl);
		writeProxyResponse(response, upstream.status || 200, {
			...corsHeaders(),
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store'
		}, request.method === 'HEAD' ? undefined : rendered);
	}

	private async handleResourceRequest(
		token: string,
		requestUrl: URL,
		request: http.IncomingMessage,
		response: http.ServerResponse
	): Promise<void> {
		if (!this.pageTargets.has(token)) {
			writeProxyResponse(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Unknown proxy resource');
			return;
		}

		const targetUrl = requestUrl.searchParams.get('url');
		if (!targetUrl || !isHttpUrl(targetUrl)) {
			writeProxyResponse(response, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Invalid proxy resource URL');
			return;
		}

		await this.forwardTargetResource(token, targetUrl, request, response);
	}

	private async handleImplicitResourceRequest(
		token: string,
		requestUrl: URL,
		request: http.IncomingMessage,
		response: http.ServerResponse
	): Promise<void> {
		const baseUrl = this.pageTargets.get(token);
		if (!baseUrl) {
			writeProxyResponse(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Unknown proxy page');
			return;
		}

		const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, baseUrl).toString();
		await this.forwardTargetResource(token, targetUrl, request, response);
	}

	private async forwardTargetResource(
		token: string,
		targetUrl: string,
		request: http.IncomingMessage,
		response: http.ServerResponse
	): Promise<void> {
		const method = request.method || 'GET';
		const body = method === 'GET' || method === 'HEAD' ? undefined : await readRequestBody(request);
		const upstream = await fetch(targetUrl, {
			method,
			redirect: 'follow',
			headers: {
				...createForwardHeaders(request),
				...createCookieRequestHeader(this.createCookieHeader(token, targetUrl))
			},
			body
		});
		this.storeResponseCookies(token, upstream, upstream.url || targetUrl);
		if (method === 'HEAD') {
			await writeUpstreamResponse(response, upstream, true);
			return;
		}

		const contentType = upstream.headers.get('content-type') || '';
		if (isJavaScriptContentType(contentType) || isCssContentType(contentType)) {
			const resourceBaseUrl = await this.createExternalResourceBaseUrl(token);
			const source = await upstream.text();
			const rewritten = isJavaScriptContentType(contentType)
				? rewriteJavaScriptResourceUrls(source, upstream.url || targetUrl, resourceBaseUrl)
				: rewriteCssResourceUrls(source, upstream.url || targetUrl, resourceBaseUrl);
			writeProxyResponse(response, upstream.status || 200, sanitizeUpstreamHeaders(upstream), rewritten);
			return;
		}

		await writeUpstreamResponse(response, upstream, false);
	}

	private resolveTokenFromReferer(referer: string | undefined): string | undefined {
		if (!referer) {
			return undefined;
		}
		try {
			const refererUrl = new URL(referer);
			const queryToken = refererUrl.searchParams.get(PROXY_PAGE_TOKEN_QUERY);
			if (queryToken && this.pageTargets.has(queryToken)) {
				return queryToken;
			}
			const match = refererUrl.pathname.match(/^\/(?:page|resource)\/([^/]+)/);
			if (match && this.pageTargets.has(match[1])) {
				return match[1];
			}
			const visiblePath = `${refererUrl.pathname}${refererUrl.search}`;
			for (const [token, targetUrl] of Array.from(this.pageTargets.entries()).reverse()) {
				const target = new URL(targetUrl);
				if (`${target.pathname}${target.search}` === visiblePath) {
					return token;
				}
			}
		} catch {
			// Ignore malformed referer headers.
		}
		return undefined;
	}

	private async createExternalResourceBaseUrl(token: string): Promise<string> {
		if (!this.port) {
			throw new Error('浏览器代理服务尚未启动。');
		}
		const localResourceBase = `http://127.0.0.1:${this.port}/resource/${token}?url=`;
		const externalResourceBase = await this.toWebviewReachableUri(vscode.Uri.parse(localResourceBase));
		if (/[?&]url=$/.test(externalResourceBase)) {
			return externalResourceBase;
		}
		return `${externalResourceBase}${externalResourceBase.includes('?') ? '&' : '?'}url=`;
	}

	private async toWebviewReachableUri(uri: vscode.Uri): Promise<string> {
		if (this.extensionKind === vscode.ExtensionKind.Workspace && vscode.env.remoteName) {
			return (await vscode.env.asExternalUri(uri)).toString(true);
		}
		return uri.toString(true);
	}

	private createCookieHeader(token: string, targetUrl: string): string | undefined {
		const jar = this.cookieJars.get(token);
		if (!jar) {
			return undefined;
		}
		const target = new URL(targetUrl);
		const now = Date.now();
		const matches: StoredProxyCookie[] = [];
		for (const [key, cookie] of jar) {
			if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
				jar.delete(key);
				continue;
			}
			const domainMatches = cookie.hostOnly
				? target.hostname === cookie.domain
				: target.hostname === cookie.domain || target.hostname.endsWith(`.${cookie.domain}`);
			if (domainMatches
				&& target.pathname.startsWith(cookie.path)
				&& (!cookie.secure || target.protocol === 'https:')) {
				matches.push(cookie);
			}
		}
		matches.sort((left, right) => right.path.length - left.path.length);
		return matches.length ? matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
	}

	private storeResponseCookies(token: string, response: Response, responseUrl: string): void {
		const jar = this.cookieJars.get(token);
		if (!jar) {
			return;
		}
		for (const header of readSetCookieHeaders(response.headers)) {
			const cookie = parseSetCookie(header, responseUrl);
			if (!cookie) {
				continue;
			}
			const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
			if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
				jar.delete(key);
			} else {
				jar.set(key, cookie);
			}
		}
	}
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
	private hasRendered = false;
	private lastWebviewUrl: string | undefined;
	private lastPostMessage: BrowserDebugPanelState['lastPostMessage'];

	public static create(context: vscode.ExtensionContext, input: BrowserInput, urlProxy: BrowserUrlProxy): IntegratedBrowserView {
		const panel = vscode.window.createWebviewPanel(
			input.mode === 'url' ? BROWSER_VIEW_TYPE : HTML_PREVIEW_EDITOR_VIEW_TYPE,
			input.title,
			vscode.ViewColumn.Active,
			{
				...resolveWebviewOptions(context, input),
				retainContextWhenHidden: true
			}
		);
		return new IntegratedBrowserView(context, panel, input, true, urlProxy);
	}

	public static attach(
		context: vscode.ExtensionContext,
		panel: vscode.WebviewPanel,
		input: BrowserInput,
		urlProxy: BrowserUrlProxy
	): IntegratedBrowserView {
		panel.webview.options = resolveWebviewOptions(context, input);
		return new IntegratedBrowserView(context, panel, input, false, urlProxy);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		input: BrowserInput,
		private readonly revealOnShow: boolean,
		private readonly urlProxy: BrowserUrlProxy
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
		const canUpdateUrlInPlace = this.hasRendered
			&& this.currentInput.mode === 'url'
			&& input.mode === 'url'
			&& !input.html;
		this.currentInput = input;
		this.lastWebviewUrl = undefined;
		this.selectedElement = undefined;
		this.panel.title = input.title;
		if (canUpdateUrlInPlace) {
			this.postMessage({
				type: 'loadUrl',
				url: input.url,
				title: input.title,
				proxyUrl: input.proxyUrl
			});
			if (this.revealOnShow && !this.panel.visible) {
				this.panel.reveal(undefined, false);
			}
			return;
		}
		this.panel.webview.options = resolveWebviewOptions(this.context, input);
		this.panel.webview.html = this.renderHtml(input);
		this.hasRendered = true;
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

	public setInspectMode(enabled: boolean): void {
		this.postMessage({ type: 'setInspectMode', enabled });
	}

	public selectElementBySelector(selector: string, options?: BrowserSelectionOptions): void {
		this.postMessage({
			type: 'selectElementBySelector',
			selector,
			copyToClipboard: options?.copyToClipboard
		});
	}

	public getDebugState(key: string): BrowserDebugPanelState {
		return {
			key,
			title: this.panel.title,
			mode: this.currentInput.mode,
			url: this.currentInput.url,
			webviewUrl: this.lastWebviewUrl,
			proxyUrl: this.currentInput.proxyUrl,
			selectedElement: this.selectedElement,
			lastPostMessage: this.lastPostMessage,
			visible: this.panel.visible,
			active: this.panel.active
		};
	}

	private postMessage(message: ExtensionToWebviewMessage): void {
		this.lastPostMessage = { type: message.type };
		void this.panel.webview.postMessage(message).then(delivered => {
			this.lastPostMessage = { type: message.type, delivered };
		});
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
				if (message.copyToClipboard !== false) {
					await this.copySelectedElementToClipboard(message.element);
				}
				break;
			case 'exportLogs':
				await this.exportLogs();
				break;
			case 'navigated':
				this.lastWebviewUrl = message.url;
				this.panel.title = `浏览 ${message.url}`;
				this.currentInput = {
					...this.currentInput,
					title: this.panel.title,
					mode: 'url',
					url: message.url
				};
				break;
			case 'navigateToUrl':
				await vscode.commands.executeCommand('smartPageTranslator.browser.openUrl', message.url);
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
			baseHref: input.baseHref || (input.sourceUri
				? ensureTrailingSlash(this.panel.webview.asWebviewUri(parentUriOf(vscode.Uri.parse(input.sourceUri))).toString())
				: ''),
			proxyUrl: input.proxyUrl,
			resourceBaseUrl: input.resourceBaseUrl,
			enablePageScripts: configuration.get<boolean>('enablePageScripts', true),
			focusLockEnabled: configuration.get<boolean>('focusLockIndicator.enabled', true)
		};

		if (input.mode === 'html' || (input.mode === 'url' && input.html !== undefined)) {
			return renderLocalHtmlPreviewDocument(input.title, payload, nonce);
		}

		const settingsJson = JSON.stringify(payload).replace(/</g, '\\u003C');
		const csp = [
			`default-src 'none'`,
			`img-src ${this.panel.webview.cspSource} data: blob: http: https:`,
			`font-src ${this.panel.webview.cspSource} data:`,
			`style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
			`script-src ${this.panel.webview.cspSource} 'unsafe-inline' http: https: data: blob:`,
			`frame-src * data: blob: ${this.panel.webview.cspSource}`,
			`connect-src *`,
			`worker-src blob:`
		].join('; ');

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
			<iframe id="browser-frame" title="集成浏览器页面"></iframe>
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

function renderProxiedBrowserDocument(html: string, targetUrl: string, resourceBaseUrl: string): string {
	const preparedHtml = rewriteProxiedHtmlResourceUrls(stripContentSecurityPolicyMeta(html), targetUrl, resourceBaseUrl);
	const base = !/<base\b/i.test(preparedHtml)
		? `<base href="${escapeAttribute(targetUrl)}">`
		: '';
	const proxySettings = JSON.stringify({
		targetUrl,
		resourceBaseUrl
	}).replace(/</g, '\\u003C');
	const bridge = [
		`window.__smartPageTranslatorProxy = ${proxySettings};`,
		getFrameBridgeSource()
	].join('\n').replace(/<\/script/gi, '<\\/script');
	return injectIntoHtmlHead(preparedHtml, targetUrl, [
		base,
		`<script>${bridge}</script>`
	].filter(Boolean).join('\n'));
}

function renderNonHtmlProxyDocument(targetUrl: string, contentType: string, body: string): string {
	return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${escapeHtml(targetUrl)}</title></head>
<body>
	<main>
		<h1>无法作为网页预览</h1>
		<p>${escapeHtml(contentType || '未知内容类型')}</p>
		<pre>${escapeHtml(body.slice(0, 4000))}</pre>
	</main>
</body>
</html>`;
}

function renderBrowserLoadErrorDocument(targetUrl: string, message: string): string {
	return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>网页加载失败</title></head>
<body>
	<main id="smart-page-translator-load-error" role="alert">
		<h1>网页加载失败</h1>
		<p>${escapeHtml(targetUrl)}</p>
		<pre>${escapeHtml(message)}</pre>
	</main>
</body>
</html>`;
}

function rewriteProxiedHtmlResourceUrls(html: string, targetUrl: string, resourceBaseUrl: string): string {
	const rewriteAttribute = (source: string, tagNamePattern: string, attributeName: string): string => {
		const pattern = new RegExp(`(<${tagNamePattern}\\b[^>]*?\\s${attributeName}\\s*=\\s*)(["'])(.*?)\\2`, 'gi');
		return source.replace(pattern, (_match, prefix: string, quote: string, value: string) => (
			`${prefix}${quote}${escapeAttribute(resolveProxiedResourceUrl(value, targetUrl, resourceBaseUrl))}${quote}`
		));
	};

	let rewritten = html;
	rewritten = rewriteAttribute(rewritten, '(?:script|iframe|img|source|audio|video|track|embed)', 'src');
	rewritten = rewriteAttribute(rewritten, '(?:video|audio)', 'poster');
	rewritten = rewriteAttribute(rewritten, 'object', 'data');
	rewritten = rewriteAttribute(rewritten, 'link', 'href');
	rewritten = rewritten.replace(
		/(<script\b(?=[^>]*\btype\s*=\s*(["']?)module\2)(?![^>]*\bsrc\s*=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
		(_match, openingTag: string, _typeQuote: string, source: string, closingTag: string) => (
			`${openingTag}${rewriteJavaScriptResourceUrls(source, targetUrl, resourceBaseUrl)}${closingTag}`
		)
	);
	rewritten = rewritten.replace(/(<(?:img|source)\b[^>]*?\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (
		_match,
		prefix: string,
		quote: string,
		value: string
	) => `${prefix}${quote}${escapeAttribute(rewriteSrcset(value, targetUrl, resourceBaseUrl))}${quote}`);
	return rewritten;
}

function resolveProxiedResourceUrl(rawValue: string, targetUrl: string, resourceBaseUrl: string): string {
	const value = rawValue.trim();
	if (!value || value.startsWith('#') || /^(data|blob|about|javascript|mailto|tel):/i.test(value)) {
		return rawValue;
	}
	try {
		const resolved = new URL(value, targetUrl);
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
			return rawValue;
		}
		return `${resourceBaseUrl}${encodeURIComponent(resolved.toString())}`;
	} catch {
		return rawValue;
	}
}

function rewriteSrcset(rawValue: string, targetUrl: string, resourceBaseUrl: string): string {
	if (/data:/i.test(rawValue)) {
		return rawValue;
	}
	return rawValue.split(',').map(candidate => {
		const leading = candidate.match(/^\s*/)?.[0] || '';
		const trailing = candidate.match(/\s*$/)?.[0] || '';
		const trimmed = candidate.trim();
		if (!trimmed) {
			return candidate;
		}
		const [url, ...descriptor] = trimmed.split(/\s+/);
		const proxied = resolveProxiedResourceUrl(url, targetUrl, resourceBaseUrl);
		return `${leading}${proxied}${descriptor.length ? ` ${descriptor.join(' ')}` : ''}${trailing}`;
	}).join(',');
}

function isJavaScriptContentType(contentType: string): boolean {
	return /(?:javascript|ecmascript|typescript|jsx|tsx)/i.test(contentType);
}

function isCssContentType(contentType: string): boolean {
	return /text\/css/i.test(contentType);
}

function rewriteJavaScriptResourceUrls(source: string, targetUrl: string, resourceBaseUrl: string): string {
	const ast = parse(source, {
		sourceType: 'unambiguous',
		plugins: ['jsx', 'typescript', 'dynamicImport', 'importAttributes']
	});
	const replacements: Array<{ readonly start: number; readonly end: number; readonly value: string }> = [];
	const addTextReplacement = (node: { readonly start?: number | null; readonly end?: number | null }, value: string): void => {
		if (typeof node.start !== 'number' || typeof node.end !== 'number') {
			return;
		}
		replacements.push({ start: node.start, end: node.end, value });
	};
	const addReplacement = (node: { readonly start?: number | null; readonly end?: number | null; readonly value?: unknown }): void => {
		if (typeof node.start !== 'number' || typeof node.end !== 'number' || typeof node.value !== 'string') {
			return;
		}
		const resolved = resolveProxiedResourceUrl(node.value, targetUrl, resourceBaseUrl);
		if (resolved === node.value) {
			return;
		}
		const original = source.slice(node.start, node.end);
		const quote = original.startsWith("'") ? "'" : '"';
		addTextReplacement(node, `${quote}${resolved}${quote}`);
	};

	traverseModule(ast, {
		ImportDeclaration(path) {
			addReplacement(path.node.source);
		},
		ExportNamedDeclaration(path) {
			if (path.node.source) {
				addReplacement(path.node.source);
			}
		},
		ExportAllDeclaration(path) {
			addReplacement(path.node.source);
		},
		CallExpression(path) {
			if (path.node.callee.type === 'Import' && path.node.arguments[0]?.type === 'StringLiteral') {
				addReplacement(path.node.arguments[0]);
			}
		},
		VariableDeclarator(path) {
			if (path.node.id.type === 'Identifier'
				&& path.node.id.name === '__vite__css'
				&& path.node.init?.type === 'StringLiteral') {
				const rewrittenCss = rewriteCssResourceUrls(path.node.init.value, targetUrl, resourceBaseUrl);
				if (rewrittenCss !== path.node.init.value) {
					addTextReplacement(path.node.init, JSON.stringify(rewrittenCss));
				}
			}
		}
	});

	let rewritten = source;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		rewritten = `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`;
	}
	return rewritten;
}

function rewriteCssResourceUrls(source: string, targetUrl: string, resourceBaseUrl: string): string {
	let rewritten = source.replace(
		/(url\(\s*)(['"]?)([^'"\)]+)\2(\s*\))/gi,
		(_match, prefix: string, quote: string, resource: string, suffix: string) => (
			`${prefix}${quote}${resolveProxiedResourceUrl(resource, targetUrl, resourceBaseUrl)}${quote}${suffix}`
		)
	);
	rewritten = rewritten.replace(
		/(@import\s+)(['"])([^'"\r\n]+)\2/gi,
		(_match, prefix: string, quote: string, resource: string) => (
			`${prefix}${quote}${resolveProxiedResourceUrl(resource, targetUrl, resourceBaseUrl)}${quote}`
		)
	);
	return rewritten;
}

function writeProxyResponse(
	response: http.ServerResponse,
	statusCode: number,
	headers: Record<string, string>,
	body: string | Buffer | undefined
): void {
	if (response.headersSent) {
		return;
	}
	response.writeHead(statusCode, headers);
	response.end(body);
}

async function writeUpstreamResponse(response: http.ServerResponse, upstream: Response, skipBody: boolean): Promise<void> {
	const headers = sanitizeUpstreamHeaders(upstream);
	if (skipBody) {
		writeProxyResponse(response, upstream.status || 200, headers, undefined);
		return;
	}

	const body = Buffer.from(await upstream.arrayBuffer());
	writeProxyResponse(response, upstream.status || 200, headers, body);
}

function sanitizeUpstreamHeaders(upstream: Response): Record<string, string> {
	const headers: Record<string, string> = corsHeaders();
	const blocked = new Set([
		'content-security-policy',
		'content-security-policy-report-only',
		'x-frame-options',
		'set-cookie',
		'transfer-encoding',
		'connection',
		'content-encoding',
		'content-length'
	]);
	upstream.headers.forEach((value, key) => {
		if (!blocked.has(key.toLowerCase())) {
			headers[key] = value;
		}
	});
	headers['cache-control'] = headers['cache-control'] || 'no-store';
	return headers;
}

function corsHeaders(): Record<string, string> {
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
		'access-control-allow-headers': '*'
	};
}

function createForwardHeaders(request: http.IncomingMessage): Record<string, string> {
	const headers: Record<string, string> = {};
	const blocked = new Set([
		'host',
		'origin',
		'referer',
		'connection',
		'content-length',
		'accept-encoding'
	]);
	for (const [key, value] of Object.entries(request.headers)) {
		if (blocked.has(key.toLowerCase()) || value === undefined) {
			continue;
		}
		headers[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	headers['user-agent'] = headers['user-agent'] || 'SmartPageTranslator/1.0 VSCodeWebviewProxy';
	return headers;
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function fetchBrowserDocument(targetUrl: string, cookieHeader?: string): Promise<Response> {
	return fetch(targetUrl, {
		method: 'GET',
		redirect: 'follow',
		headers: {
			accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'user-agent': 'SmartPageTranslator/1.0 VSCodeWebviewProxy',
			...createCookieRequestHeader(cookieHeader)
		}
	});
}

function createCookieRequestHeader(cookieHeader: string | undefined): Record<string, string> {
	return cookieHeader ? { cookie: cookieHeader } : {};
}

function readSetCookieHeaders(headers: Headers): readonly string[] {
	const extended = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof extended.getSetCookie === 'function') {
		return extended.getSetCookie();
	}
	const combined = headers.get('set-cookie');
	return combined ? combined.split(/,(?=\s*[^;,=\s]+\s*=)/) : [];
}

function parseSetCookie(header: string, responseUrl: string): StoredProxyCookie | undefined {
	const response = new URL(responseUrl);
	const [nameValue, ...attributes] = header.split(';');
	const separator = nameValue.indexOf('=');
	if (separator <= 0) {
		return undefined;
	}
	const name = nameValue.slice(0, separator).trim();
	const value = nameValue.slice(separator + 1).trim();
	let domain = response.hostname.toLowerCase();
	let path = defaultCookiePath(response.pathname);
	let secure = false;
	let hostOnly = true;
	let expiresAt: number | undefined;

	for (const rawAttribute of attributes) {
		const attributeSeparator = rawAttribute.indexOf('=');
		const attributeName = (attributeSeparator < 0 ? rawAttribute : rawAttribute.slice(0, attributeSeparator)).trim().toLowerCase();
		const attributeValue = attributeSeparator < 0 ? '' : rawAttribute.slice(attributeSeparator + 1).trim();
		if (attributeName === 'domain' && attributeValue) {
			const requestedDomain = attributeValue.replace(/^\./, '').toLowerCase();
			if (response.hostname === requestedDomain || response.hostname.endsWith(`.${requestedDomain}`)) {
				domain = requestedDomain;
				hostOnly = false;
			}
		} else if (attributeName === 'path' && attributeValue.startsWith('/')) {
			path = attributeValue;
		} else if (attributeName === 'secure') {
			secure = true;
		} else if (attributeName === 'max-age' && /^-?\d+$/.test(attributeValue)) {
			expiresAt = Date.now() + Number(attributeValue) * 1000;
		} else if (attributeName === 'expires' && expiresAt === undefined) {
			const parsed = Date.parse(attributeValue);
			if (!Number.isNaN(parsed)) {
				expiresAt = parsed;
			}
		}
	}

	return { name, value, domain, path, secure, hostOnly, expiresAt };
}

function defaultCookiePath(pathname: string): string {
	if (!pathname.startsWith('/') || pathname === '/') {
		return '/';
	}
	const finalSlash = pathname.lastIndexOf('/');
	return finalSlash <= 0 ? '/' : pathname.slice(0, finalSlash);
}

function parseWebSocketProtocols(value: string | string[] | undefined): string[] {
	const combined = Array.isArray(value) ? value.join(',') : value || '';
	return combined.split(',').map(protocol => protocol.trim()).filter(Boolean);
}

function bridgeWebSockets(downstream: WebSocket, upstream: WebSocket): void {
	downstream.on('message', (data, isBinary) => {
		if (upstream.readyState === WebSocket.OPEN) {
			upstream.send(data, { binary: isBinary });
		}
	});
	upstream.on('message', (data, isBinary) => {
		if (downstream.readyState === WebSocket.OPEN) {
			downstream.send(data, { binary: isBinary });
		}
	});

	downstream.on('close', (code, reason) => closePeerWebSocket(upstream, code, reason));
	upstream.on('close', (code, reason) => closePeerWebSocket(downstream, code, reason));
	downstream.on('error', () => upstream.terminate());
	upstream.on('error', () => downstream.terminate());
}

function closePeerWebSocket(peer: WebSocket, code: number, reason: Buffer): void {
	if (peer.readyState !== WebSocket.OPEN && peer.readyState !== WebSocket.CONNECTING) {
		return;
	}
	if (peer.readyState === WebSocket.CONNECTING || code < 1000 || code === 1005 || code === 1006) {
		peer.terminate();
		return;
	}
	peer.close(code, reason.toString('utf8').slice(0, 123));
}

function rejectWebSocketUpgrade(socket: import('stream').Duplex, statusCode: number, message: string): void {
	if (socket.destroyed) {
		return;
	}
	const body = Buffer.from(message, 'utf8');
	socket.end([
		`HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Error'}`,
		'Connection: close',
		'Content-Type: text/plain; charset=utf-8',
		`Content-Length: ${body.length}`,
		'',
		message
	].join('\r\n'));
}

function resolveInitialClientRedirect(html: string, currentUrl: string): string | undefined {
	// Some sites return a tiny bootstrap document that redirects by inspecting location.href.
	// In an injected Webview, location points at vscode-webview://, so resolve that redirect here.
	if (html.length > 16_384) {
		return undefined;
	}

	const schemeReplacement = html.match(
		/location\.(?:replace|assign)\s*\(\s*location\.href\.replace\s*\(\s*(['"])(https?:\/\/)\1\s*,\s*(['"])(https?:\/\/)\3\s*\)\s*\)/i
	);
	if (schemeReplacement) {
		const redirected = currentUrl.replace(new RegExp(`^${escapeRegExp(schemeReplacement[2])}`, 'i'), schemeReplacement[4]);
		return redirected !== currentUrl && isHttpUrl(redirected) ? redirected : undefined;
	}

	const directScriptRedirect = html.match(
		/location\.(?:href\s*=|replace\s*\(|assign\s*\()\s*(['"])(https?:\/\/[^'"\s)]+)\1\s*\)?/i
	);
	if (directScriptRedirect) {
		return new URL(directScriptRedirect[2], currentUrl).toString();
	}

	const metaRefresh = html.match(
		/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(['"]?)refresh\1)[^>]*\bcontent\s*=\s*(['"])([^'"]+)\2[^>]*>/i
	);
	const metaTarget = metaRefresh?.[3].match(/(?:^|;)\s*url\s*=\s*(['"]?)(.*?)\1\s*$/i)?.[2];
	if (metaTarget) {
		const redirected = new URL(metaTarget, currentUrl).toString();
		return isHttpUrl(redirected) ? redirected : undefined;
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		resourceBaseUrl: settings.resourceBaseUrl,
		focusLockEnabled: settings.focusLockEnabled
	};
	const settingsJson = JSON.stringify(runtimeSettings).replace(/</g, '\\u003C');
	const csp = settings.mode === 'url'
		? [
			`default-src 'none'`,
			`img-src data: blob: http: https:`,
			`media-src data: blob: http: https:`,
			`font-src data: http: https:`,
			`style-src 'unsafe-inline' http: https:`,
			`script-src 'unsafe-inline' http: https: data: blob:`,
			`connect-src *`,
			`frame-src data: blob: http: https:`
		].join('; ')
		: '';
	const headExtras = [
		csp ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">` : '',
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
	return html.replace(
		/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)\b)[^>]*>/gi,
		''
	);
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
const vscode = window.__smartPageTranslatorVsCodeApi || (window.__smartPageTranslatorVsCodeApi = acquireVsCodeApi());
const settings = JSON.parse(document.getElementById('browser-settings')?.textContent || '{}');
let inspectMode = false;
let hoveredElement;
	let toastTimer;
	let pendingPageError;

	patchConsole();
	if (settings.resourceBaseUrl) {
		patchNetworkRequests();
	}
	window.addEventListener('error', event => {
	reportPageError(event.message);
});
window.addEventListener('unhandledrejection', event => {
	reportPageError('Unhandled rejection: ' + stringifyValue(event.reason));
});
window.addEventListener('message', event => {
	const data = event.data;
	if (!data || typeof data.type !== 'string') {
		return;
	}
		if (data.type === 'setInspectMode') {
			setInspectMode(Boolean(data.enabled));
		} else if (data.type === 'selectElementBySelector') {
			selectElementBySelector(data.selector, data.copyToClipboard);
		} else if (data.type === 'loadUrl') {
			loadUrl(data);
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
		if (pendingPageError) {
			showToast('页面脚本错误：' + pendingPageError, 'error');
		}
		document.addEventListener('mousemove', handleInspectMove, true);
		document.addEventListener('pointerdown', handleInspectPointerEvent, true);
		document.addEventListener('mousedown', handleInspectPointerEvent, true);
		document.addEventListener('mouseup', handleInspectPointerEvent, true);
		document.addEventListener('click', handleInspectClick, true);
		document.addEventListener('click', handleLinkClick, true);
		vscode.postMessage({ type: 'ready' });
		if (settings.mode === 'url' && settings.url) {
			vscode.postMessage({ type: 'navigated', url: settings.url });
		}
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

		const urlInput = document.getElementById('url-input');
		urlInput.value = settings.url || location.href;
		if (settings.mode === 'url') {
			urlInput.removeAttribute('readonly');
			urlInput.addEventListener('change', () => navigateToUrl(urlInput.value));
			urlInput.addEventListener('keydown', event => {
				if (event.key === 'Enter') {
					event.preventDefault();
					navigateToUrl(urlInput.value);
					urlInput.blur();
				}
			});
		}
		document.getElementById('reload-button').addEventListener('click', () => {
			if (settings.mode === 'url' && settings.url) {
				navigateToUrl(settings.url);
				return;
			}
			location.reload();
		});
		document.getElementById('inspect-button').addEventListener('click', () => setInspectMode(!inspectMode));
	document.getElementById('logs-button').addEventListener('click', () => vscode.postMessage({ type: 'exportLogs' }));
	document.getElementById('external-button').addEventListener('click', () => {
		if (settings.url) {
			vscode.postMessage({ type: 'openExternal', url: settings.url });
		}
	});
		document.getElementById('devtools-button').addEventListener('click', () => vscode.postMessage({ type: 'openDevTools' }));
	}

	function navigateToUrl(value) {
		const nextUrl = normalizeUrl(value || settings.url || location.href);
		settings.url = nextUrl;
		const urlInput = document.getElementById('url-input');
		if (urlInput) {
			urlInput.value = nextUrl;
		}
		vscode.postMessage({ type: 'navigateToUrl', url: nextUrl });
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

	function installToast() {
	const toast = document.createElement('section');
	toast.id = 'smart-page-translator-browser-toast';
	toast.setAttribute('aria-live', 'polite');
	document.body.appendChild(toast);
}

	function reportPageError(message) {
		pendingPageError = String(message || '未知页面脚本错误');
		recordLog('error', pendingPageError, 'page');
		if (document.getElementById('smart-page-translator-browser-toast')) {
			showToast('页面脚本错误：' + pendingPageError, 'error');
		}
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

	function patchNetworkRequests() {
		const originalFetch = window.fetch ? window.fetch.bind(window) : undefined;
		if (originalFetch) {
			window.fetch = function patchedFetch(input, init) {
				if (typeof Request !== 'undefined' && input instanceof Request) {
					const method = init?.method || input.method;
					const nextInit = {
						method,
						headers: init?.headers || input.headers,
						body: method && !/^(GET|HEAD)$/i.test(method) ? (init?.body || input.body) : undefined,
						...init
					};
					return originalFetch(proxyResourceUrl(input.url), nextInit);
				}
				return originalFetch(proxyResourceUrl(input), init);
			};
		}

		const originalOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
			return originalOpen.call(this, method, proxyResourceUrl(url), async, user, password);
		};
	}

	function proxyResourceUrl(value) {
		if (!settings.resourceBaseUrl) {
			return value;
		}
		const raw = typeof value === 'string'
			? value
			: value && typeof value.url === 'string'
				? value.url
				: String(value || '');
		if (!raw || /^(data|blob|about|javascript|mailto|tel):/i.test(raw)) {
			return value;
		}
		try {
			const resolved = new URL(raw, settings.baseHref || settings.url || document.baseURI || location.href).toString();
			return settings.resourceBaseUrl + encodeURIComponent(resolved);
		} catch {
			return value;
		}
	}

	function handleInspectMove(event) {
	if (!inspectMode || !(event.target instanceof Element) || isPreviewChrome(event.target)) {
		return;
	}
	clearHover();
	hoveredElement = event.target;
	hoveredElement.classList.add('spt-browser-hover-outline');
}

function handleInspectPointerEvent(event) {
	if (!inspectMode || !(event.target instanceof Element) || isPreviewChrome(event.target)) {
		return;
	}
	event.preventDefault();
	event.stopImmediatePropagation();
}

function handleInspectClick(event) {
	if (!inspectMode || !(event.target instanceof Element) || isPreviewChrome(event.target)) {
		return;
	}
	event.preventDefault();
	event.stopImmediatePropagation();
	const element = describeElement(event.target);
	postSelectedElement(element);
}

function handleLinkClick(event) {
	if (settings.mode !== 'url' || inspectMode || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) {
		return;
	}
	const anchor = event.target.closest('a[href]');
	if (!anchor || anchor.target || anchor.hasAttribute('download')) {
		return;
	}
	const href = anchor.href;
	if (!href || /^(javascript|mailto|tel):/i.test(href)) {
		return;
	}
	event.preventDefault();
	navigateToUrl(href);
}

function selectElementBySelector(selector, copyToClipboard) {
	const cssSelector = String(selector || '');
	if (!cssSelector) {
		return;
	}
	try {
		const element = document.querySelector(cssSelector);
		if (element instanceof Element && !isPreviewChrome(element)) {
			clearHover();
			hoveredElement = element;
			hoveredElement.classList.add('spt-browser-hover-outline');
			postSelectedElement(describeElement(element), copyToClipboard);
		} else {
			recordLog('warn', 'Selector did not match any selectable element: ' + cssSelector, 'page');
		}
	} catch (error) {
		recordLog('error', 'Invalid selector: ' + cssSelector + ' - ' + errorMessage(error), 'page');
	}
}

function postSelectedElement(element, copyToClipboard) {
	setTimeout(() => {
		vscode.postMessage({ type: 'selectedElement', element, copyToClipboard });
	}, 0);
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

function getFrameBridgeSource(): string {
	return `
		(function smartPageTranslatorFrameBridge() {
			const channel = 'smartPageTranslator.browser';
			const proxy = window.__smartPageTranslatorProxy;
			const send = (payload) => window.parent.postMessage({ channel, payload }, '*');
			const escapeCss = (value) => {
			if (window.CSS && typeof window.CSS.escape === 'function') {
				return window.CSS.escape(value);
		}
		return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
	};
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
	const proxyResourceUrl = (value) => {
		if (!proxy || !proxy.resourceBaseUrl) {
			return value;
		}
		const raw = typeof value === 'string'
			? value
			: value && typeof value.url === 'string'
				? value.url
				: String(value || '');
		if (!raw || /^(data|blob|about|javascript|mailto|tel):/i.test(raw)) {
			return value;
		}
		try {
			const resolved = new URL(raw, proxy.targetUrl || document.baseURI || location.href).toString();
			return proxy.resourceBaseUrl + encodeURIComponent(resolved);
		} catch {
			return value;
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

	if (proxy && proxy.resourceBaseUrl) {
		patchNetworkRequests();
	}

	let inspectMode = false;
	let hovered;
	installHoverStyle();

	const describeElement = (element) => {
		const rect = element.getBoundingClientRect();
		const path = [];
		let current = element;
		while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
			let part = current.tagName.toLowerCase();
			if (current.id) {
				part += '#' + escapeCss(current.id);
				path.unshift(part);
				break;
			}
			const classNames = String(current.className || '').split(/\\s+/).filter(Boolean).slice(0, 2);
			if (classNames.length) {
				part += '.' + classNames.map(name => escapeCss(name)).join('.');
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
		if (inspectMode && event.target instanceof Element) {
			event.preventDefault();
			event.stopPropagation();
			send({ type: 'selectedElement', element: describeElement(event.target) });
			return;
		}
		if (!proxy || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) {
			return;
		}
		const anchor = event.target.closest('a[href]');
		if (!anchor || anchor.target || anchor.hasAttribute('download')) {
			return;
		}
		const href = anchor.href;
		if (!href || /^(javascript|mailto|tel):/i.test(href)) {
			return;
		}
		event.preventDefault();
		send({ type: 'navigateToUrl', url: href });
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
			return;
		}
		if (event.data.type === 'selectElementBySelector') {
			const selector = typeof event.data.selector === 'string' ? event.data.selector : '';
			if (!selector) {
				return;
			}
			try {
				const element = document.querySelector(selector);
				if (element instanceof Element) {
					clearHover();
					hovered = element;
					hovered.classList.add('spt-browser-hover-outline');
					send({ type: 'selectedElement', element: describeElement(element), copyToClipboard: event.data.copyToClipboard });
				} else {
					send({ type: 'pageLog', level: 'warn', values: ['Selector did not match any element: ' + selector] });
				}
			} catch (error) {
				send({ type: 'pageLog', level: 'error', values: ['Invalid selector: ' + selector + ' - ' + stringify(error)] });
			}
		}
	});

	function installHoverStyle() {
		const append = () => {
			if (document.getElementById('smart-page-translator-frame-bridge-style')) {
				return;
			}
			const style = document.createElement('style');
			style.id = 'smart-page-translator-frame-bridge-style';
			style.textContent = '.spt-browser-hover-outline{outline:2px solid #4da3ff !important; outline-offset:2px !important;}';
			(document.head || document.documentElement).appendChild(style);
		};
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', append, { once: true });
		} else {
			append();
		}
	}

	function patchNetworkRequests() {
		const originalFetch = window.fetch ? window.fetch.bind(window) : undefined;
		if (originalFetch) {
			window.fetch = function patchedFetch(input, init) {
				if (typeof Request !== 'undefined' && input instanceof Request) {
					const method = init?.method || input.method;
					const nextInit = {
						method,
						headers: init?.headers || input.headers,
						body: method && !/^(GET|HEAD)$/i.test(method) ? (init?.body || input.body) : undefined,
						...init
					};
					return originalFetch(proxyResourceUrl(input.url), nextInit);
				}
				return originalFetch(proxyResourceUrl(input), init);
			};
		}

		const originalOpen = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
			return originalOpen.call(this, method, proxyResourceUrl(url), async, user, password);
		};
	}
})();`;
}

function getWebviewScript(): string {
	return `
const vscode = window.__smartPageTranslatorVsCodeApi || (window.__smartPageTranslatorVsCodeApi = acquireVsCodeApi());
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
	let renderSequence = 0;
	let frameInspectDisposables = [];
	let frameHoveredElement;
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
	} else if (data.type === 'selectElementBySelector') {
		selectElementBySelector(data.selector, data.copyToClipboard);
	} else if (data.type === 'loadUrl') {
		loadUrl(data);
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
		settings.proxyUrl = undefined;
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

	function loadUrl(payload) {
		const nextUrl = normalizeUrl(payload && payload.url ? payload.url : '');
		settings.mode = 'url';
		settings.url = nextUrl;
		settings.proxyUrl = payload ? payload.proxyUrl : undefined;
		currentUrl = nextUrl;
		input.value = nextUrl;
		document.title = payload && payload.title ? payload.title : '浏览 ' + nextUrl;
		renderCurrentInput();
	}

		function renderCurrentInput() {
		const sequence = ++renderSequence;
		disposeFrameInspectMode();
		if (settings.mode === 'html') {
			frame.removeAttribute('src');
			const loaded = waitForFrameLoad();
			frame.srcdoc = buildInstrumentedHtml(settings.html || '');
			void loaded.then(() => installFrameInspectMode(inspectMode));
			return;
		}

		void renderRemoteInput(sequence);
	}

	async function renderRemoteInput(sequence) {
		const normalized = normalizeUrl(currentUrl);
		currentUrl = normalized;
		input.value = normalized;
		document.title = '浏览 ' + normalized;
		frame.removeAttribute('srcdoc');

		if (!settings.proxyUrl) {
			frame.src = normalized;
			vscode.postMessage({ type: 'navigated', url: normalized });
			return;
		}

		frame.removeAttribute('src');
		frame.srcdoc = buildStatusHtml('正在加载网页', normalized);

		try {
			const response = await fetch(settings.proxyUrl, { cache: 'no-store' });
			const html = await response.text();
			if (sequence !== renderSequence) {
				return;
			}
			if (!response.ok) {
				throw new Error('HTTP ' + response.status + ' ' + response.statusText + ': ' + html.slice(0, 300));
			}

			const loaded = waitForFrameLoad();
			frame.srcdoc = html;
			await loaded;
			if (sequence !== renderSequence) {
				return;
			}
			installFrameInspectMode(inspectMode);
			vscode.postMessage({ type: 'navigated', url: normalized });
		} catch (error) {
			if (sequence !== renderSequence) {
				return;
			}
			const loaded = waitForFrameLoad();
			frame.srcdoc = buildStatusHtml('无法打开网页', errorMessage(error));
			await loaded;
			vscode.postMessage({ type: 'navigated', url: normalized });
			notify('无法打开网页：' + errorMessage(error), 'error');
		}
	}

	function waitForFrameLoad() {
		return new Promise(resolve => {
			let settled = false;
			let timer;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				frame.removeEventListener('load', finish);
				resolve();
			};
			timer = setTimeout(finish, 5000);
			frame.addEventListener('load', finish, { once: true });
		});
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

	function buildStatusHtml(title, detail) {
		return [
			'<!doctype html>',
			'<html lang="zh-CN">',
			'<head>',
			'<meta charset="UTF-8">',
			'<style>',
			'html,body{height:100%;margin:0;background:#ffffff;color:#1f2328;font-family:system-ui,sans-serif;}',
			'body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}',
			'main{max-width:720px;width:100%;}',
			'h1{margin:0 0 8px;font-size:18px;font-weight:600;}',
			'p{margin:0;color:#57606a;overflow-wrap:anywhere;line-height:1.5;}',
			'</style>',
			'</head>',
			'<body><main><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(detail || '') + '</p></main></body>',
			'</html>'
		].join('');
	}

function getBridgeSource() {
	return ${JSON.stringify(getFrameBridgeSource())};
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
		setTimeout(() => {
			vscode.postMessage({ type: 'selectedElement', element: payload.element, copyToClipboard: payload.copyToClipboard });
		}, 0);
		return;
	}
	if (payload.type === 'navigateToUrl') {
		vscode.postMessage({ type: 'navigateToUrl', url: payload.url });
	}
}

function setInspectMode(enabled) {
	inspectMode = enabled;
	inspectButton.classList.toggle('active', enabled);
	if (installFrameInspectMode(enabled)) {
		return;
	}
	if (frame.getAttribute('srcdoc') !== null) {
		notify('当前页面暂时不可选择元素。', 'warning');
		return;
	}
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

function selectElementBySelector(selector, copyToClipboard) {
	if (selectElementInFrame(selector, copyToClipboard)) {
		return;
	}
	if (frame.getAttribute('srcdoc') !== null) {
		recordLog('warn', 'Current srcdoc frame is not accessible for selector: ' + String(selector || ''), 'browser');
		return;
	}
	try {
		frame.contentWindow.postMessage({
			channel: 'smartPageTranslator.browser.control',
			type: 'selectElementBySelector',
			selector: String(selector || ''),
			copyToClipboard
		}, '*');
	} catch {
		notify('当前页面跨域，无法选择元素。', 'warning');
	}
}

function installFrameInspectMode(enabled) {
	disposeFrameInspectMode();
	if (!enabled) {
		return true;
	}
	const doc = getFrameDocument();
	if (!doc || !doc.documentElement) {
		return false;
	}
	ensureFrameHoverStyle(doc);
	const handleMove = event => {
		if (!inspectMode || !isFrameElement(event.target)) {
			return;
		}
		clearFrameHover();
		frameHoveredElement = event.target;
		frameHoveredElement.classList.add('spt-browser-hover-outline');
	};
	const handleClick = event => {
		if (!inspectMode || !isFrameElement(event.target)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setTimeout(() => {
			vscode.postMessage({ type: 'selectedElement', element: describeFrameElement(event.target) });
		}, 0);
	};
	doc.addEventListener('mousemove', handleMove, true);
	doc.addEventListener('click', handleClick, true);
	frameInspectDisposables = [
		() => doc.removeEventListener('mousemove', handleMove, true),
		() => doc.removeEventListener('click', handleClick, true)
	];
	return true;
}

function disposeFrameInspectMode() {
	clearFrameHover();
	while (frameInspectDisposables.length) {
		const dispose = frameInspectDisposables.pop();
		try {
			dispose();
		} catch {
			// Ignore stale frame listeners from a document that is being replaced.
		}
	}
}

function clearFrameHover() {
	if (!frameHoveredElement) {
		return;
	}
	frameHoveredElement.classList.remove('spt-browser-hover-outline');
	frameHoveredElement = undefined;
}

function selectElementInFrame(selector, copyToClipboard) {
	const doc = getFrameDocument();
	if (!doc || !doc.documentElement) {
		return false;
	}
	const cssSelector = String(selector || '');
	if (!cssSelector) {
		return true;
	}
	try {
		const element = doc.querySelector(cssSelector);
		if (isFrameElement(element)) {
			ensureFrameHoverStyle(doc);
			clearFrameHover();
			frameHoveredElement = element;
			frameHoveredElement.classList.add('spt-browser-hover-outline');
			setTimeout(() => {
				vscode.postMessage({ type: 'selectedElement', element: describeFrameElement(element), copyToClipboard });
			}, 0);
		} else {
			recordLog('warn', 'Selector did not match any element: ' + cssSelector, 'page');
		}
	} catch (error) {
		recordLog('error', 'Invalid selector: ' + cssSelector + ' - ' + errorMessage(error), 'page');
	}
	return true;
}

function getFrameDocument() {
	try {
		return frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : undefined);
	} catch {
		return undefined;
	}
}

function ensureFrameHoverStyle(doc) {
	if (doc.getElementById('smart-page-translator-frame-parent-style')) {
		return;
	}
	const style = doc.createElement('style');
	style.id = 'smart-page-translator-frame-parent-style';
	style.textContent = '.spt-browser-hover-outline{outline:2px solid #4da3ff !important;outline-offset:2px !important;}';
	(doc.head || doc.documentElement).appendChild(style);
}

function isFrameElement(value) {
	return Boolean(value && value.nodeType === 1 && typeof value.tagName === 'string');
}

function describeFrameElement(element) {
	const doc = element.ownerDocument || document;
	const rect = element.getBoundingClientRect();
	const path = [];
	let current = element;
	while (current && current.nodeType === 1 && current !== doc.documentElement) {
		let part = current.tagName.toLowerCase();
		if (current.id) {
			part += '#' + escapeFrameCss(current.id, doc);
			path.unshift(part);
			break;
		}
		const classNames = String(current.className || '').split(/\\s+/).filter(Boolean).slice(0, 2);
		if (classNames.length) {
			part += '.' + classNames.map(name => escapeFrameCss(name, doc)).join('.');
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

function escapeFrameCss(value, doc) {
	const css = doc.defaultView && doc.defaultView.CSS ? doc.defaultView.CSS : window.CSS;
	if (css && typeof css.escape === 'function') {
		return css.escape(value);
	}
	return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
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
	}

	function escapeHtml(value) {
		return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}`;
	}

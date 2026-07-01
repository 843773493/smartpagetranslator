import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import { basenameOfUri, displayPathOfUri, parentUriOf } from './rootFileUri';

const HTML_PREVIEW_VIEW_TYPE = 'smartPageTranslator.htmlPreview';

export class HtmlPreviewManager {
	private readonly panels = new Map<string, vscode.WebviewPanel>();

	public async open(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		const existing = this.panels.get(key);
		if (existing) {
			existing.reveal(undefined, false);
			existing.webview.html = await this.renderWebviewHtml(existing.webview, uri);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			HTML_PREVIEW_VIEW_TYPE,
			`预览 ${basenameOfUri(uri) || displayPathOfUri(uri)}`,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [parentUriOf(uri)]
			}
		);
		this.panels.set(key, panel);
		panel.onDidDispose(() => this.panels.delete(key));
		panel.webview.html = await this.renderWebviewHtml(panel.webview, uri);
	}

	private async renderWebviewHtml(webview: vscode.Webview, uri: vscode.Uri): Promise<string> {
		const content = await vscode.workspace.fs.readFile(uri);
		const html = new TextDecoder('utf-8').decode(content);
		const baseHref = ensureTrailingSlash(webview.asWebviewUri(parentUriOf(uri)).toString());
		return injectBaseElement(html, baseHref);
	}
}

function injectBaseElement(html: string, baseHref: string): string {
	if (/<base\b/i.test(html)) {
		return html;
	}

	const base = `<base href="${escapeAttribute(baseHref)}">`;
	const headPattern = /<head(\s[^>]*)?>/i;
	if (headPattern.test(html)) {
		return html.replace(headPattern, match => `${match}\n${base}`);
	}

	const htmlPattern = /<html(\s[^>]*)?>/i;
	if (htmlPattern.test(html)) {
		return html.replace(htmlPattern, match => `${match}\n<head>${base}</head>`);
	}

	// TODO: 后续如需覆盖复杂 HTML 片段，可引入 HTML parser 代替正则插入 <base>。
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	${base}
</head>
<body>
${html}
</body>
</html>`;
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

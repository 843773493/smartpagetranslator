import { translate } from 'bing-translate-api';
import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Smart Page Translator is now active');

    // 注册翻译命令
    let disposable = vscode.commands.registerCommand(
        'smartPageTranslator.translate',
        async () => {
            try {
                // 优先获取活动编辑器，其次为可见编辑器或打开的文档
                let document: vscode.TextDocument | undefined;

                // 优先尝试从活动标签获取文件（支持第三方 viewer）
                try {
                    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
                    if (activeTab) {
                        const input: any = activeTab.input;
                        const tabUri: vscode.Uri | undefined = input && (input.uri || input.resource || input.localResource);
                        if (tabUri && tabUri.scheme === 'file') {
                            try {
                                document = await vscode.workspace.openTextDocument(tabUri);
                                const output = vscode.window.createOutputChannel('Smart Page Translator');
                                output.appendLine(`[Translator] Using file from active tab: ${tabUri.fsPath}`);
                            } catch (e) {
                                // ignore and fall back
                            }
                        }
                    }
                } catch (e) {
                    // ignore
                }

                const editor = vscode.window.activeTextEditor;

                // 仅当 activeTab 未能定位到文档时，才使用活动编辑器（避免覆盖 activeTab 的正确结果）
                if (!document && editor) {
                    document = editor.document;
                }

                // 未找到可用文档则直接停止并提示
                if (!document) {
                    vscode.window.showWarningMessage('❌ No document found. Please focus the tab or open a text file.');
                    return;
                }

                const text = document.getText();

                if (!text.trim()) {
                    vscode.window.showWarningMessage('❌ Document is empty');
                    return;
                }

                // 显示进度通知（可取消）
                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Translating...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        const output = vscode.window.createOutputChannel('Smart Page Translator');
                        output.clear();
                        output.show(true);
                        output.appendLine(`[Translator] Translating document: ${document.fileName}`);

                        token.onCancellationRequested(() => {
                            output.appendLine('[Translator] Cancellation requested by user');
                        });

                        try {
                            progress.report({ message: 'Preparing and splitting text...' });

                            // 将文本拆分为不超过 MAX_CHUNK 的块（尽量保留完整单词）
                            const MAX_CHUNK = 1000;
                            function chunkText(t: string, maxLen = MAX_CHUNK): string[] {
                                // 使用基于空白的分割以避免拆断单词
                                const tokens = t.split(/(\s+)/);
                                const chunks: string[] = [];
                                let current = '';
                                for (const tok of tokens) {
                                    if ((current + tok).length > maxLen) {
                                        if (current.length === 0) {
                                            // token itself is longer than maxLen, force split
                                            let rest = tok;
                                            while (rest.length > 0) {
                                                chunks.push(rest.slice(0, maxLen));
                                                rest = rest.slice(maxLen);
                                            }
                                        } else {
                                            chunks.push(current);
                                            current = tok;
                                        }
                                    } else {
                                        current += tok;
                                    }
                                }
                                if (current.length) chunks.push(current);
                                return chunks;
                            }

                            const chunks = chunkText(text, MAX_CHUNK);
                            output.appendLine(`[Translator] Total chunks: ${chunks.length}`);

                            // 批量翻译分块以控制并发并支持取消
                            async function translateChunks(chunks: string[], concurrency = 4): Promise<string> {
                                const results: string[] = new Array(chunks.length);
                                for (let i = 0; i < chunks.length; i += concurrency) {
                                    if (token.isCancellationRequested) {
                                        output.appendLine('[Translator] Aborting before starting next batch due to cancellation');
                                        throw new Error('Cancelled');
                                    }

                                    const batch = chunks.slice(i, i + concurrency).map((chunk, idx) => {
                                        const index = i + idx;
                                        return translate(chunk, null, 'zh-Hans')
                                            .then(res => {
                                                results[index] = res.translation ?? '';
                                                output.appendLine(`[Translator] Chunk ${index + 1}/${chunks.length} translated (len=${results[index].length})`);
                                                progress.report({ message: `Translating chunk ${index + 1}/${chunks.length}` });
                                            })
                                            .catch(err => {
                                                output.appendLine(`[Translator] Error translating chunk ${index + 1}: ${String(err)}`);
                                                results[index] = '';
                                            });
                                    });

                                    await Promise.all(batch);
                                }
                                return results.join('');
                            }

                            // 从用户设置读取并发数（默认 20）
                            const cfg = vscode.workspace.getConfiguration('smartPageTranslator');
                            const userConcurrency = cfg.get<number>('concurrency', 20);
                            const concurrency = Math.max(1, Math.min(100, Math.floor(userConcurrency)));
                            output.appendLine(`[Translator] Using concurrency: ${concurrency}`);

                            let translatedText: string;
                            try {
                                translatedText = await translateChunks(chunks, concurrency);
                            } catch (err) {
                                if (String(err).includes('Cancelled')) {
                                    output.appendLine('[Translator] Translation cancelled by user');
                                    vscode.window.showInformationMessage('Translation cancelled');
                                    return;
                                }
                                output.appendLine(`[Translator] Fatal error translating chunks: ${String(err)}`);
                                throw err;
                            }

                            progress.report({ message: 'Finalizing translation...' });

                            if (document.uri.scheme === 'file') {
                                // 生成带 zh-CN 后缀的建议文件名（用于 untitled 标签），但不写入磁盘
                                const originalPath = document.fileName;
                                const ext = path.extname(originalPath);
                                const basename = path.basename(originalPath, ext);
                                const dir = path.dirname(originalPath);
                                const suggestedPath = path.join(dir, `${basename}.zh-CN${ext}`);

                                // 在未保存的 untitled 编辑器中打开翻译结果并插入内容
                                const untitledUri = vscode.Uri.parse(`untitled:${suggestedPath}`);
                                const newDoc = await vscode.workspace.openTextDocument(untitledUri);
                                const newEditor = await vscode.window.showTextDocument(newDoc);
                                await newEditor.edit(edit => {
                                    edit.insert(new vscode.Position(0, 0), translatedText);
                                });

                                output.appendLine(`[Translator] Translation complete, opened in unsaved editor: ${suggestedPath}`);
                                vscode.window.showInformationMessage(
                                    `✅ Translation complete! Opened: ${path.basename(suggestedPath)} (unsaved)`
                                );
                            } else {
                                // 虚拟文档：在未命名编辑器中打开翻译结果（不写磁盘）
                                const newDoc = await vscode.workspace.openTextDocument({ content: translatedText, language: document.languageId });
                                await vscode.window.showTextDocument(newDoc);

                                output.appendLine('[Translator] Translation complete, opened in new untitled editor (unsaved)');
                                vscode.window.showInformationMessage('✅ Translation complete! Opened translated content in a new unsaved editor');
                            }
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            console.error('Translation error:', error);
                            vscode.window.showErrorMessage(
                                `❌ Translation failed: ${errorMessage}`
                            );
                        }
                    }
                );
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error('Command error:', error);
                vscode.window.showErrorMessage(
                    `❌ Error: ${errorMessage}`
                );
            }
        }
    );

    context.subscriptions.push(disposable);
}

export function deactivate() {
    console.log('Smart Page Translator is now deactivated');
}

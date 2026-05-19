import { translate } from 'bing-translate-api';
import * as path from 'path';
import * as vscode from 'vscode';

export function registerTranslateCommand(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    logFn: (label: string, message: string) => void,
) {
    const disposable = vscode.commands.registerCommand(
        'smartPageTranslator.translate',
        async () => {
            try {
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
                                logFn(path.basename(tabUri.fsPath), `Using file from active tab: ${tabUri.fsPath}`);
                            } catch (e) {
                                // ignore and fall back
                            }
                        }
                    }
                } catch (e) {
                    // ignore
                }

                const editor = vscode.window.activeTextEditor;

                // 仅当 activeTab 未能定位到文档时，才使用活动编辑器
                if (!document && editor) {
                    document = editor.document;
                }

                if (!document) {
                    vscode.window.showWarningMessage('❌ No document found. Please focus the tab or open a text file.');
                    return;
                }

                const text = document.getText();

                if (!text.trim()) {
                    vscode.window.showWarningMessage('❌ Document is empty');
                    return;
                }

                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Translating...',
                        cancellable: true,
                    },
                    async (progress, token) => {
                        output.clear();
                        output.show(true);
                        const docLabel = path.basename(document!.fileName);
                        logFn(docLabel, `Translating document: ${document!.fileName}`);

                        token.onCancellationRequested(() => {
                            logFn(docLabel, 'Cancellation requested by user');
                        });

                        try {
                            progress.report({ message: 'Preparing and splitting text...' });

                            const settings = vscode.workspace.getConfiguration('smartPageTranslator');
                            const userMaxChunk = settings.get<number>('maxChunk', 1000);
                            const MAX_CHUNK = Math.max(100, Math.min(10000, Math.floor(Number(userMaxChunk) || 1000)));
                            logFn(docLabel, `Using max chunk size: ${MAX_CHUNK}`);

                            function chunkText(t: string, maxLen = MAX_CHUNK): string[] {
                                const tokens = t.split(/(\s+)/);
                                const chunks: string[] = [];
                                let current = '';
                                for (const tok of tokens) {
                                    if ((current + tok).length > maxLen) {
                                        if (current.length === 0) {
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
                            logFn(docLabel, `Total chunks: ${chunks.length}`);

                            async function translateChunks(chunks: string[], concurrency = 4): Promise<string> {
                                const results: string[] = new Array(chunks.length);
                                for (let i = 0; i < chunks.length; i += concurrency) {
                                    if (token.isCancellationRequested) {
                                        logFn(docLabel, 'Aborting before starting next batch due to cancellation');
                                        throw new Error('Cancelled');
                                    }

                                    const batch = chunks.slice(i, i + concurrency).map((chunk, idx) => {
                                        const index = i + idx;
                                        return translate(chunk, null, 'zh-Hans')
                                            .then(res => {
                                                results[index] = res.translation ?? '';
                                                logFn(docLabel, `Chunk ${index + 1}/${chunks.length} translated (len=${results[index].length})`);
                                                progress.report({ message: `Translating chunk ${index + 1}/${chunks.length}` });
                                            })
                                            .catch(err => {
                                                logFn(docLabel, `Error translating chunk ${index + 1}: ${String(err)}`);
                                                results[index] = '';
                                            });
                                    });

                                    await Promise.all(batch);
                                }
                                return results.join('');
                            }

                            const userConcurrency = settings.get<number>('concurrency', 20);
                            const concurrency = Math.max(1, Math.min(100, Math.floor(userConcurrency)));
                            logFn(docLabel, `Using concurrency: ${concurrency}`);

                            let translatedText: string;
                            try {
                                translatedText = await translateChunks(chunks, concurrency);
                            } catch (err) {
                                if (String(err).includes('Cancelled')) {
                                    logFn(docLabel, 'Translation cancelled by user');
                                    vscode.window.showInformationMessage('Translation cancelled');
                                    return;
                                }
                                logFn(docLabel, `Fatal error translating chunks: ${String(err)}`);
                                throw err;
                            }

                            progress.report({ message: 'Finalizing translation...' });

                            if (document!.uri.scheme === 'file') {
                                const originalPath = document!.fileName;
                                const ext = path.extname(originalPath);
                                const basename = path.basename(originalPath, ext);
                                const dir = path.dirname(originalPath);
                                const suggestedPath = path.join(dir, `${basename}.zh-CN${ext}`);

                                const untitledUri = vscode.Uri.parse(`untitled:${suggestedPath}`);
                                const newDoc = await vscode.workspace.openTextDocument(untitledUri);
                                const newEditor = await vscode.window.showTextDocument(newDoc);
                                await newEditor.edit(edit => {
                                    edit.insert(new vscode.Position(0, 0), translatedText);
                                });

                                logFn(docLabel, `Translation complete, opened in unsaved editor: ${suggestedPath}`);
                                vscode.window.showInformationMessage(
                                    `✅ Translation complete! Opened: ${path.basename(suggestedPath)} (unsaved)`
                                );
                            } else {
                                const newDoc = await vscode.workspace.openTextDocument({ content: translatedText, language: document!.languageId });
                                await vscode.window.showTextDocument(newDoc);

                                logFn(docLabel, 'Translation complete, opened in new untitled editor (unsaved)');
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

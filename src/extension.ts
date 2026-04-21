import { translate } from 'bing-translate-api';
import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Smart Page Translator is now active');

    const output = vscode.window.createOutputChannel('Smart Page Translator');
    context.subscriptions.push(output);

    // 简单日志封装：带 ISO 时间戳与文件/任务前缀
    function log(label: string, message: string) {
        output.appendLine(`[${new Date().toISOString()}] [${label}] ${message}`);
    }

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
                                log(path.basename(tabUri.fsPath), `Using file from active tab: ${tabUri.fsPath}`);
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
                        output.clear();
                        output.show(true);
                        const docLabel = path.basename(document.fileName);
                        log(docLabel, `Translating document: ${document.fileName}`);

                        token.onCancellationRequested(() => {
                            log(docLabel, 'Cancellation requested by user');
                        });

                        try {
                            progress.report({ message: 'Preparing and splitting text...' });

                            // 将文本拆分为不超过 MAX_CHUNK 的块（尽量保留完整单词）
                            // 从用户设置读取最大分块长度（默认 1000）
                            const settings = vscode.workspace.getConfiguration('smartPageTranslator');
                            const userMaxChunk = settings.get<number>('maxChunk', 1000);
                            const MAX_CHUNK = Math.max(100, Math.min(10000, Math.floor(Number(userMaxChunk) || 1000)));
                            log(docLabel, `Using max chunk size: ${MAX_CHUNK}`);
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
                            log(docLabel, `Total chunks: ${chunks.length}`);

                            // 批量翻译分块以控制并发并支持取消
                            async function translateChunks(chunks: string[], concurrency = 4): Promise<string> {
                                const results: string[] = new Array(chunks.length);
                                for (let i = 0; i < chunks.length; i += concurrency) {
                                    if (token.isCancellationRequested) {
                                        log(docLabel, 'Aborting before starting next batch due to cancellation');
                                        throw new Error('Cancelled');
                                    }

                                    const batch = chunks.slice(i, i + concurrency).map((chunk, idx) => {
                                        const index = i + idx;
                                        return translate(chunk, null, 'zh-Hans')
                                            .then(res => {
                                                results[index] = res.translation ?? '';
                                                log(docLabel, `Chunk ${index + 1}/${chunks.length} translated (len=${results[index].length})`);
                                                progress.report({ message: `Translating chunk ${index + 1}/${chunks.length}` });
                                            })
                                            .catch(err => {
                                                log(docLabel, `Error translating chunk ${index + 1}: ${String(err)}`);
                                                results[index] = '';
                                            });
                                    });

                                    await Promise.all(batch);
                                }
                                return results.join('');
                            }

                            // 从用户设置读取并发数（默认 20）
                            const userConcurrency = settings.get<number>('concurrency', 20);
                            const concurrency = Math.max(1, Math.min(100, Math.floor(userConcurrency)));
                            log(docLabel, `Using concurrency: ${concurrency}`);

                            let translatedText: string;
                            try {
                                translatedText = await translateChunks(chunks, concurrency);
                            } catch (err) {
                                if (String(err).includes('Cancelled')) {
                                    log(docLabel, 'Translation cancelled by user');
                                    vscode.window.showInformationMessage('Translation cancelled');
                                    return;
                                }
                                log(docLabel, `Fatal error translating chunks: ${String(err)}`);
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

                                log(docLabel, `Translation complete, opened in unsaved editor: ${suggestedPath}`);
                                vscode.window.showInformationMessage(
                                    `✅ Translation complete! Opened: ${path.basename(suggestedPath)} (unsaved)`
                                );
                            } else {
                                // 虚拟文档：在未命名编辑器中打开翻译结果（不写磁盘）
                                const newDoc = await vscode.workspace.openTextDocument({ content: translatedText, language: document.languageId });
                                await vscode.window.showTextDocument(newDoc);

                                log(docLabel, 'Translation complete, opened in new untitled editor (unsaved)');
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

    // 注册 AST outline 提取命令
    const extractAstDisposable = vscode.commands.registerCommand(
        'smartPageTranslator.extractAstOutline',
        async () => {
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showErrorMessage('No active editor');
                    return;
                }

                const document = editor.document;
                const filePath = document.uri.fsPath;

                const ext = path.extname(filePath).toLowerCase();
                const supportedExts = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py'];
                if (!supportedExts.includes(ext)) {
                    vscode.window.showErrorMessage(`Unsupported file type: ${ext}`);
                    return;
                }

                log('AST', `Extracting outline from: ${filePath}`);

                const scriptPath = path.join(context.extensionPath, 'scripts', 'extract-ast.mjs');
                if (!require('fs').existsSync(scriptPath)) {
                    vscode.window.showErrorMessage('extract-ast.mjs script not found');
                    return;
                }

                const { spawnSync } = require('child_process');
                const output = spawnSync('node', [scriptPath, filePath], {
                    encoding: 'utf8',
                    maxBuffer: 10 * 1024 * 1024,
                });

                if (output.error || output.status !== 0) {
                    const errorMsg = output.error?.message || output.stderr || 'Failed to extract AST';
                    vscode.window.showErrorMessage(`Error: ${errorMsg}`);
                    return;
                }

                const outline = output.stdout;
                await vscode.env.clipboard.writeText(outline);
                vscode.window.showInformationMessage('AST outline copied to clipboard!');
                log('AST', 'Outline copied to clipboard');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`❌ Error: ${errorMessage}`);
            }
        }
    );

    context.subscriptions.push(extractAstDisposable);

    // 注册 tsx 运行命令
    async function runFileInTerminal(
        uri: vscode.Uri | undefined,
        options: {
            terminalName: string;
            commandLine: string;
            supportedExts: string[];
            successMessage: (relativePath: string) => string;
            logLabel: string;
        },
    ): Promise<void> {
        try {
            let targetUri = uri;

            if (!targetUri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    vscode.window.showWarningMessage('请先打开一个支持的文件');
                    return;
                }
                targetUri = activeEditor.document.uri;
            }

            if (targetUri.scheme !== 'file') {
                vscode.window.showErrorMessage('仅支持本地文件');
                return;
            }

            const filePath = targetUri.fsPath;
            const ext = path.extname(filePath).toLowerCase();
            if (!options.supportedExts.includes(ext)) {
                vscode.window.showErrorMessage(`不支持的文件类型: ${ext}`);
                return;
            }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
            const cwd = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(filePath);
            const relativePath = path.relative(cwd, filePath).replace(/\\/g, '/');

            let terminal = vscode.window.terminals.find((t) => t.name === options.terminalName);
            if (!terminal) {
                terminal = vscode.window.createTerminal({
                    name: options.terminalName,
                    cwd,
                });
            }

            terminal.sendText(`${options.commandLine} "${relativePath}"`);
            terminal.show();

            log(options.logLabel, `启动终端运行: ${options.commandLine} "${relativePath}"`);
            vscode.window.showInformationMessage(options.successMessage(relativePath));
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`${options.logLabel} error:`, error);
            vscode.window.showErrorMessage(`❌ 运行失败: ${errorMessage}`);
        }
    }

    const runWithTsxDisposable = vscode.commands.registerCommand('smartPageTranslator.runWithTsx', async (uri?: vscode.Uri) => {
        await runFileInTerminal(uri, {
            terminalName: 'tsx',
            commandLine: 'npx tsx',
            supportedExts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
            successMessage: (relativePath) => `✅ 已启动 tsx 运行: ${relativePath}`,
            logLabel: 'TSX',
        });
    });

    const runPytestDisposable = vscode.commands.registerCommand('smartPageTranslator.runPytest', async (uri?: vscode.Uri) => {
        await runFileInTerminal(uri, {
            terminalName: 'pytest',
            commandLine: 'pytest',
            supportedExts: ['.py'],
            successMessage: (relativePath) => `✅ 已启动 pytest 运行: ${relativePath}`,
            logLabel: 'PYTEST',
        });
    });

    context.subscriptions.push(runWithTsxDisposable, runPytestDisposable);
}

export function deactivate() {
    console.log('Smart Page Translator is now deactivated');
}

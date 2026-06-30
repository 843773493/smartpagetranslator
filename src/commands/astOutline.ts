import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';

let lastAstOutline = '';

export function registerAstOutlineCommand(
    context: vscode.ExtensionContext,
    logFn: (label: string, message: string) => void,
) {
    const disposable = vscode.commands.registerCommand(
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

                logFn('AST', `Extracting outline from: ${filePath}`);

                const scriptPath = path.join(context.extensionPath, 'scripts', 'extract-ast.mjs');
                if (!fs.existsSync(scriptPath)) {
                    vscode.window.showErrorMessage('extract-ast.mjs script not found');
                    return;
                }

                const result = spawnSync('node', [scriptPath, filePath], {
                    encoding: 'utf8',
                    maxBuffer: 10 * 1024 * 1024,
                });

                if (result.error || result.status !== 0) {
                    const errorMsg = result.error?.message || result.stderr || 'Failed to extract AST';
                    vscode.window.showErrorMessage(`Error: ${errorMsg}`);
                    return;
                }

                const outline = result.stdout;
                await vscode.env.clipboard.writeText(outline);
                lastAstOutline = outline;
                vscode.window.showInformationMessage('AST outline copied to clipboard!');
                logFn('AST', 'Outline copied to clipboard');
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`❌ Error: ${errorMessage}`);
            }
        }
    );

    context.subscriptions.push(disposable);
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'smartPageTranslator.internal.getLastAstOutline',
            () => lastAstOutline,
        )
    );
}

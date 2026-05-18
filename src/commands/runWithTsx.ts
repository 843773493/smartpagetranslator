import * as vscode from 'vscode';
import { runFileInTerminal } from '../utils/terminal';

export function registerRunWithTsxCommand(
    context: vscode.ExtensionContext,
    logFn: (label: string, message: string) => void,
) {
    const disposable = vscode.commands.registerCommand(
        'smartPageTranslator.runWithTsx',
        async (uri?: vscode.Uri) => {
            await runFileInTerminal(uri, {
                terminalName: 'tsx',
                commandLine: 'npx tsx',
                supportedExts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
                successMessage: (relativePath) => `✅ 已启动 tsx 运行: ${relativePath}`,
                logLabel: 'TSX',
            }, logFn);
        }
    );

    context.subscriptions.push(disposable);
}

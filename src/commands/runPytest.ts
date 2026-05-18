import * as vscode from 'vscode';
import { runFileInTerminal } from '../utils/terminal';

export function registerRunPytestCommand(
    context: vscode.ExtensionContext,
    logFn: (label: string, message: string) => void,
) {
    const disposable = vscode.commands.registerCommand(
        'smartPageTranslator.runPytest',
        async (uri?: vscode.Uri) => {
            await runFileInTerminal(uri, {
                terminalName: 'pytest',
                commandLine: 'pytest',
                supportedExts: ['.py'],
                successMessage: (relativePath) => `✅ 已启动 pytest 运行: ${relativePath}`,
                logLabel: 'PYTEST',
            }, logFn);
        }
    );

    context.subscriptions.push(disposable);
}

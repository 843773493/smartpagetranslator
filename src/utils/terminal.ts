import * as path from 'path';
import * as vscode from 'vscode';

export interface RunTerminalOptions {
    terminalName: string;
    commandLine: string;
    supportedExts: string[];
    successMessage: (relativePath: string) => string;
    logLabel: string;
}

export async function runFileInTerminal(
    uri: vscode.Uri | undefined,
    options: RunTerminalOptions,
    logFn: (label: string, message: string) => void,
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

        logFn(options.logLabel, `启动终端运行: ${options.commandLine} "${relativePath}"`);
        vscode.window.showInformationMessage(options.successMessage(relativePath));
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`${options.logLabel} error:`, error);
        vscode.window.showErrorMessage(`❌ 运行失败: ${errorMessage}`);
    }
}

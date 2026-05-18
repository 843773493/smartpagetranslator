import * as vscode from 'vscode';

export function log(output: vscode.OutputChannel, label: string, message: string) {
    output.appendLine(`[${new Date().toISOString()}] [${label}] ${message}`);
}

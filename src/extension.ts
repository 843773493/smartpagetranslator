import * as vscode from 'vscode';
import { registerTranslateCommand } from './commands/translate';
import { registerAstOutlineCommand } from './commands/astOutline';
import { registerRunWithTsxCommand } from './commands/runWithTsx';
import { registerRunPytestCommand } from './commands/runPytest';
import { log } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    console.log('Smart Page Translator is now active');

    const output = vscode.window.createOutputChannel('Smart Page Translator');
    context.subscriptions.push(output);

    const logFn = (label: string, message: string) => log(output, label, message);

    registerTranslateCommand(context, output);
    registerAstOutlineCommand(context, output);
    registerRunWithTsxCommand(context, logFn);
    registerRunPytestCommand(context, logFn);
}

export function deactivate() {
    console.log('Smart Page Translator is now deactivated');
}

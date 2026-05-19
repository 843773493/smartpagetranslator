import * as vscode from 'vscode';
import { registerAstOutlineCommand } from './commands/astOutline';
import { registerRunPytestCommand } from './commands/runPytest';
import { registerRunWithTsxCommand } from './commands/runWithTsx';
import { registerTranslateCommand } from './commands/translate';
import { getNotesExtensions, getNotesLocation, registerNotesCommands } from './notes/notesCommands';
import { NotesViewProvider } from './notes/notesViewProvider';
import { log } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    console.log('Smart Page Translator is now active');

    const output = vscode.window.createOutputChannel('Smart Page Translator');
    context.subscriptions.push(output);

    const logFn = (label: string, message: string) => log(output, label, message);
    logFn('Extension', '日志系统已初始化');

    registerTranslateCommand(context, output, logFn);
    registerAstOutlineCommand(context, logFn);
    registerRunWithTsxCommand(context, logFn);
    registerRunPytestCommand(context, logFn);

    try {
        const notesLocation = getNotesLocation();
        const notesExtensions = getNotesExtensions();

        const notesTree = new NotesViewProvider(
            notesLocation ? String(notesLocation) : '',
            notesExtensions ? String(notesExtensions) : 'md'
        );

        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('notes', notesTree.init())
        );

        registerNotesCommands(context, notesTree);
    } catch (err) {
        logFn(
            'Notes',
            `初始化 Notes 视图失败: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('smartPageTranslator.notes.notesLocation')) {
                vscode.window.showWarningMessage(
                    `检测到笔记存储位置已更改。需要重新加载窗口使更改生效。`,
                    '重新加载'
                ).then(selectedAction => {
                    if (selectedAction === '重新加载') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            }
        })
    );
}

export function deactivate() {
    console.log('Smart Page Translator is now deactivated');
}
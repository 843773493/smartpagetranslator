import * as vscode from 'vscode';
import { registerAstOutlineCommand } from './commands/astOutline';
import { registerRunPytestCommand } from './commands/runPytest';
import { registerRunWithTsxCommand } from './commands/runWithTsx';
import { registerTranslateCommand } from './commands/translate';
import { getNotesExtensions, getNotesLocation, registerNotesCommands } from './notes/notesCommands';
import { NotesViewProvider } from './notes/notesViewProvider';
import { log } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
    console.log('[DBG extension.ts] activate() CALLED');
    const output = vscode.window.createOutputChannel('Smart Page Translator');
    context.subscriptions.push(output);

    const logFn = (label: string, message: string) => log(output, label, message);
    logFn('Extension', '日志系统已初始化');

    logFn('Extension', `Current extension ID: "${context.extension.id}"`);
    logFn('Extension', `Current extension path: "${context.extensionPath}"`);

    registerTranslateCommand(context, output, logFn);
    logFn('Extension', 'registerTranslateCommand DONE');
    registerAstOutlineCommand(context, logFn);
    logFn('Extension', 'registerAstOutlineCommand DONE');
    registerRunWithTsxCommand(context, logFn);
    logFn('Extension', 'registerRunWithTsxCommand DONE');
    registerRunPytestCommand(context, logFn);
    logFn('Extension', 'registerRunPytestCommand DONE');

    let notesTree: NotesViewProvider | undefined;

    try {
        const notesLocation = getNotesLocation();
        logFn('Extension', `getNotesLocation() raw result: "${notesLocation}" (type: ${typeof notesLocation})`);
        const notesExtensions = getNotesExtensions();
        logFn('Extension', `getNotesExtensions() raw result: "${notesExtensions}" (type: ${typeof notesExtensions})`);

        if (!notesLocation || notesLocation === '') {
            logFn('Extension', 'notesLocation is empty – will create NotesViewProvider with empty string');
        }

        notesTree = new NotesViewProvider(
            notesLocation ? String(notesLocation) : '',
            notesExtensions ? String(notesExtensions) : 'md'
        );
        logFn('Extension', `NotesViewProvider created – location: "${notesLocation || ''}", extensions: "${notesExtensions || 'md'}"`);

        logFn('Extension', 'About to call vscode.window.registerTreeDataProvider("notes", ...) ...');
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('notes', notesTree.init())
        );
        logFn('Extension', 'vscode.window.registerTreeDataProvider("notes", ...) DONE – no exception thrown');

        registerNotesCommands(context, notesTree);
        logFn('Extension', 'registerNotesCommands DONE');
    } catch (err) {
        logFn(
            'Notes',
            `初始化 Notes 视图失败: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('smartPageTranslator.notes.notesLocation')) {
                if (notesTree) {
                    notesTree.updateNotesLocation(getNotesLocation());
                    vscode.window.showInformationMessage('笔记存储位置已更新，已重新加载笔记视图。');
                }
            }
        })
    );
    logFn('Extension', 'activate() FINISHED – returning to VS Code host');
}

export function deactivate() {
    console.log('[DBG extension.ts] deactivate() CALLED');
}

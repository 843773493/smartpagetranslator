import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, EXTENSION_ID } from './extension-contract.mjs';
import { switchToTopFrame } from './diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

export const workspacePath = process.env.WDIO_WORKSPACE_PATH || path.join(rootDir, 'test-fixtures', 'workspace');
export const notesPath = process.env.WDIO_NOTES_PATH || path.join(workspacePath, 'notes');

export const files = {
  astSample: path.join(workspacePath, 'src', 'sample.ts'),
  translationInput: path.join(workspacePath, 'translation-input.txt'),
  tsRunner: path.join(workspacePath, 'src', 'runner.ts'),
  pySample: path.join(workspacePath, 'python', 'test_sample.py'),
  existingNote: path.join(notesPath, 'existing.md')
};

export async function setupWorkbench() {
  await browser.getWorkbench();
  await activateExtension();
}

export async function cleanupWorkbench() {
  try {
    await browser.executeWorkbench((vscode) => {
      for (const terminal of vscode.window.terminals) {
        terminal.dispose();
      }
    });
  } catch {
    // 失败场景中 VS Code 可能已经在关闭，清理不能覆盖原始失败。
  }

  try {
    await switchToTopFrame();
  } catch {
    // 同上，避免清理错误掩盖真正的用例错误。
  }
}

export async function activateExtension() {
  return browser.executeWorkbench(async (vscode, extensionId) => {
    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension) {
      return { found: false };
    }

    await extension.activate();
    return {
      found: true,
      id: extension.id,
      isActive: extension.isActive,
      version: extension.packageJSON?.version
    };
  }, EXTENSION_ID);
}

export async function installTranslationStub() {
  return browser.executeWorkbench(async (vscode, command) => {
    await vscode.commands.executeCommand(command, true);
    return { patched: true };
  }, COMMANDS.internal.useDeterministicTranslator);
}

export async function executeCommandWithInput(command, value, commandArg) {
  return browser.executeWorkbench(async (vscode, args) => {
    const original = vscode.window.showInputBox;
    vscode.window.showInputBox = async () => args.value;
    try {
      return await vscode.commands.executeCommand(args.command, args.commandArg);
    } finally {
      vscode.window.showInputBox = original;
    }
  }, {
    command,
    value,
    commandArg
  });
}

export async function executeCommandWithWarningChoice(command, choice, commandArg) {
  return browser.executeWorkbench(async (vscode, args) => {
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (_message, ...items) => (
      items.includes(args.choice) ? args.choice : items[0]
    );
    try {
      return await vscode.commands.executeCommand(args.command, args.commandArg);
    } finally {
      vscode.window.showWarningMessage = original;
    }
  }, {
    command,
    choice,
    commandArg
  });
}

export async function executeCommandOnFile(command, targetPath) {
  return browser.executeWorkbench(async (vscode, args) => (
    vscode.commands.executeCommand(args.command, vscode.Uri.file(args.targetPath))
  ), {
    command,
    targetPath
  });
}

export async function executeCommandWithInputOnFile(command, value, targetPath) {
  return browser.executeWorkbench(async (vscode, args) => {
    const original = vscode.window.showInputBox;
    vscode.window.showInputBox = async () => args.value;
    try {
      return await vscode.commands.executeCommand(args.command, vscode.Uri.file(args.targetPath));
    } finally {
      vscode.window.showInputBox = original;
    }
  }, {
    command,
    value,
    targetPath
  });
}

export async function executeCommandWithWarningChoiceOnFile(command, choice, targetPath) {
  return browser.executeWorkbench(async (vscode, args) => {
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (_message, ...items) => (
      items.includes(args.choice) ? args.choice : items[0]
    );
    try {
      return await vscode.commands.executeCommand(args.command, vscode.Uri.file(args.targetPath));
    } finally {
      vscode.window.showWarningMessage = original;
    }
  }, {
    command,
    choice,
    targetPath
  });
}

export async function executeListNotesWithChoice(choice) {
  return browser.executeWorkbench(async (vscode, args) => {
    const original = vscode.window.showQuickPick;
    vscode.window.showQuickPick = async (items) => {
      const values = Array.isArray(items) ? items : await items;
      return values.includes(args.choice) ? args.choice : values[0];
    };
    try {
      return await vscode.commands.executeCommand(args.command);
    } finally {
      vscode.window.showQuickPick = original;
    }
  }, {
    command: COMMANDS.notes.listNotes,
    choice
  });
}

export async function waitForPath(targetPath, shouldExist) {
  await browser.waitUntil(() => fs.existsSync(targetPath) === shouldExist, {
    timeout: 10000,
    interval: 200,
    timeoutMsg: `Timed out waiting for ${targetPath} to ${shouldExist ? 'exist' : 'be removed'}`
  });
}

export async function waitForActiveEditor(predicate, label) {
  let latest;
  await browser.waitUntil(async () => {
    latest = await readActiveEditor();
    return latest ? predicate(latest) : false;
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for ${label}`
  });
  return latest;
}

export async function readActiveEditor() {
  return browser.executeWorkbench((vscode) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    return {
      fileName: editor.document.fileName,
      scheme: editor.document.uri.scheme,
      languageId: editor.document.languageId,
      text: editor.document.getText()
    };
  });
}

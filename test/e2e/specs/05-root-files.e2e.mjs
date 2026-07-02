import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  FOCUS_ROOT_FILES_VIEW_COMMAND,
  OPEN_EXPLORER_VIEW_COMMAND
} from '../support/extension-contract.mjs';
import { collectUiSnapshot } from '../support/diagnostics.mjs';
import {
  cleanupWorkbench,
  executeCommandOnFile,
  executeCommandWithInputOnFile,
  executeCommandWithWarningChoiceOnFile,
  setupWorkbench,
  waitForActiveEditor,
  waitForPath,
  workspacePath
} from '../support/harness.mjs';

describe('Smart Page Translator root file tree E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('opens the root file tree and runs common file manager operations', async () => {
    const sandboxDir = path.join(workspacePath, 'root-files-e2e');
    const createdFile = path.join(sandboxDir, 'created.txt');
    const renamedFile = path.join(sandboxDir, 'renamed.txt');
    const createdFolder = path.join(sandboxDir, 'created-folder');
    const renamedFolder = path.join(sandboxDir, 'renamed-folder');
    const copyTargetFolder = path.join(sandboxDir, 'copied-files');
    const copiedFile = path.join(copyTargetFolder, 'renamed.txt');
    const moveTargetFolder = path.join(sandboxDir, 'moved-files');
    const movedFile = path.join(moveTargetFolder, 'renamed.txt');

    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    await browser.executeWorkbench(
      async (vscode, args) => {
        await vscode.commands.executeCommand(args.openExplorer);
        await vscode.commands.executeCommand(args.focusRootFiles);
        await vscode.commands.executeCommand(args.refresh);
      },
      {
        openExplorer: OPEN_EXPLORER_VIEW_COMMAND,
        focusRootFiles: FOCUS_ROOT_FILES_VIEW_COMMAND,
        refresh: COMMANDS.rootFiles.refresh
      }
    );

    const snapshot = await collectUiSnapshot('root-file-tree-view');
    assert.match(snapshot.document.visibleText, /根目录文件树|ROOT FILES|Root/i);

    await executeCommandOnFile(COMMANDS.rootFiles.addQuickPath, sandboxDir);
    await browser.executeWorkbench(
      (vscode, command) => vscode.commands.executeCommand(command),
      COMMANDS.rootFiles.refresh
    );
    const shortcutSnapshot = await collectUiSnapshot('root-file-tree-shortcut');
    assert.match(shortcutSnapshot.document.visibleText, /快捷路径|root-files-e2e/);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.newFile, 'created.txt', sandboxDir);
    await waitForPath(createdFile, true);
    assert.equal(fs.readFileSync(createdFile, 'utf8'), '');

    const openedCreated = await waitForActiveEditor(
      (editor) => editor.fileName === createdFile,
      'created root file editor'
    );
    assert.equal(openedCreated.fileName, createdFile);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.rename, 'renamed.txt', createdFile);
    await waitForPath(renamedFile, true);
    assert.equal(fs.existsSync(createdFile), false);

    await executeCommandOnFile(COMMANDS.rootFiles.open, renamedFile);
    const openedRenamed = await waitForActiveEditor(
      (editor) => editor.fileName === renamedFile,
      'renamed root file editor'
    );
    assert.equal(openedRenamed.fileName, renamedFile);

    await executeCommandOnFile(COMMANDS.rootFiles.copyPath, renamedFile);
    const copiedPath = await browser.executeWorkbench((vscode) => vscode.env.clipboard.readText());
    assert.equal(copiedPath, renamedFile);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.newFolder, 'copied-files', sandboxDir);
    await waitForPath(copyTargetFolder, true);

    await executeCommandOnFile(COMMANDS.rootFiles.copy, renamedFile);
    await executeCommandOnFile(COMMANDS.rootFiles.paste, copyTargetFolder);
    await waitForPath(copiedFile, true);
    assert.equal(fs.existsSync(renamedFile), true);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.newFolder, 'moved-files', sandboxDir);
    await waitForPath(moveTargetFolder, true);

    await executeCommandOnFile(COMMANDS.rootFiles.cut, copiedFile);
    await executeCommandOnFile(COMMANDS.rootFiles.paste, moveTargetFolder);
    await waitForPath(movedFile, true);
    assert.equal(fs.existsSync(copiedFile), false);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.newFolder, 'created-folder', sandboxDir);
    await waitForPath(createdFolder, true);

    await executeCommandWithInputOnFile(COMMANDS.rootFiles.rename, 'renamed-folder', createdFolder);
    await waitForPath(renamedFolder, true);
    assert.equal(fs.existsSync(createdFolder), false);

    await executeCommandWithWarningChoiceOnFile(COMMANDS.rootFiles.delete, '永久删除', renamedFile);
    await waitForPath(renamedFile, false);

    await executeCommandWithWarningChoiceOnFile(COMMANDS.rootFiles.delete, '永久删除', renamedFolder);
    await waitForPath(renamedFolder, false);

    await executeCommandWithWarningChoiceOnFile(COMMANDS.rootFiles.delete, '永久删除', copyTargetFolder);
    await waitForPath(copyTargetFolder, false);

    await executeCommandWithWarningChoiceOnFile(COMMANDS.rootFiles.delete, '永久删除', moveTargetFolder);
    await waitForPath(moveTargetFolder, false);

    await executeCommandOnFile(COMMANDS.rootFiles.removeQuickPath, sandboxDir);
  });
});

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
    const localUploadSource = path.join(workspacePath, 'local-upload-source.txt');
    const localUploadFolder = path.join(workspacePath, 'local-upload-folder');
    const localUploadFolderFile = path.join(localUploadFolder, 'nested.txt');
    const uploadedSource = path.join(sandboxDir, 'local-upload-source.txt');
    const uploadedFolderFile = path.join(sandboxDir, 'local-upload-folder', 'nested.txt');
    const clipboardUploadSource = path.join(workspacePath, 'clipboard-upload-source.txt');
    const clipboardUploadedFile = path.join(sandboxDir, 'clipboard-upload-source.txt');

    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.rmSync(localUploadFolder, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.mkdirSync(localUploadFolder, { recursive: true });
    fs.writeFileSync(localUploadSource, 'uploaded through context menu command', 'utf8');
    fs.writeFileSync(localUploadFolderFile, 'uploaded directory content', 'utf8');
    fs.writeFileSync(clipboardUploadSource, 'uploaded through Ctrl+V command', 'utf8');

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
    const quickPathStorage = await browser.executeWorkbench(async (vscode, args) => {
      const storage = await vscode.commands.executeCommand(args.storageCommand);
      return {
        storage,
        expectedUri: vscode.Uri.file(args.sandboxDir).toString()
      };
    }, {
      storageCommand: COMMANDS.internal.getRootFileQuickPathStorage,
      sandboxDir
    });
    assert.ok(
      quickPathStorage.storage.workspaceQuickPaths.includes(quickPathStorage.expectedUri),
      'expected quick path to be stored in workspaceState'
    );
    assert.equal(
      quickPathStorage.storage.globalQuickPaths.includes(quickPathStorage.expectedUri),
      false,
      'expected quick path not to be stored in globalState'
    );

    await browser.executeWorkbench(
      (vscode, command) => vscode.commands.executeCommand(command),
      COMMANDS.rootFiles.refresh
    );
    const shortcutSnapshot = await collectUiSnapshot('root-file-tree-shortcut');
    assert.match(shortcutSnapshot.document.visibleText, /快捷路径|root-files-e2e/);

    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.env.clipboard.writeText(args.sources.join('\n'));
      await vscode.commands.executeCommand(args.paste, vscode.Uri.file(args.target));
    }, {
      paste: COMMANDS.rootFiles.paste,
      sources: [localUploadSource, localUploadFolder, clipboardUploadSource],
      target: sandboxDir
    });
    await waitForPath(uploadedSource, true);
    await waitForPath(uploadedFolderFile, true);
    await waitForPath(clipboardUploadedFile, true);
    assert.equal(fs.readFileSync(uploadedSource, 'utf8'), 'uploaded through context menu command');
    assert.equal(fs.readFileSync(uploadedFolderFile, 'utf8'), 'uploaded directory content');
    assert.equal(fs.readFileSync(clipboardUploadedFile, 'utf8'), 'uploaded through Ctrl+V command');

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

    fs.rmSync(localUploadSource, { force: true });
    fs.rmSync(localUploadFolder, { recursive: true, force: true });
    fs.rmSync(clipboardUploadSource, { force: true });
  });
});

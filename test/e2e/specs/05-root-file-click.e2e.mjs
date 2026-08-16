import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMANDS,
  FOCUS_ROOT_FILES_VIEW_COMMAND,
  OPEN_COMMAND,
  OPEN_EXPLORER_VIEW_COMMAND,
  OPEN_WITH_COMMAND
} from '../support/extension-contract.mjs';
import { collectUiSnapshot } from '../support/diagnostics.mjs';
import {
  cleanupWorkbench,
  executeCommandOnFile,
  setupWorkbench,
  waitForActiveEditor,
  workspacePath
} from '../support/harness.mjs';

describe('Smart Page Translator root file node click E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('opens a file node after refresh without a stale command proxy', async () => {
    const sandboxDir = path.join(workspacePath, 'root-files-click-e2e');
    const uiOpenedFile = path.join(sandboxDir, 'opened-after-refresh.txt');
    const htmlPreviewFile = path.join(workspacePath, 'html-preview.html');
    const plainTextFile = path.join(workspacePath, 'translation-input.txt');

    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(uiOpenedFile, 'opened from the refreshed root file tree', 'utf8');

    const itemCommandStates = await browser.executeWorkbench(async (vscode, args) => {
      const readState = async (targetPath) => vscode.commands.executeCommand(
        args.command,
        vscode.Uri.file(targetPath)
      );
      return Promise.all([
        readState(args.plainTextFile),
        readState(args.htmlPreviewFile)
      ]);
    }, {
      command: COMMANDS.internal.getRootFileItemCommandState,
      plainTextFile,
      htmlPreviewFile
    });
    assert.deepEqual(itemCommandStates, [
      { command: OPEN_COMMAND, argumentCount: 1 },
      { command: OPEN_WITH_COMMAND, argumentCount: 2 }
    ]);

    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.openExplorer);
      await vscode.commands.executeCommand(args.focusRootFiles);
    }, {
      openExplorer: OPEN_EXPLORER_VIEW_COMMAND,
      focusRootFiles: FOCUS_ROOT_FILES_VIEW_COMMAND
    });
    await executeCommandOnFile(COMMANDS.rootFiles.addQuickPath, sandboxDir);
    await browser.executeWorkbench(
      (vscode, command) => vscode.commands.executeCommand(command),
      COMMANDS.rootFiles.refresh
    );

    const workbench = await browser.getWorkbench();
    const viewContent = workbench.getSideBar().getContent();
    const sections = await viewContent.getSections();
    for (const section of sections) {
      if (await section.getTitle() === '根目录文件树') {
        await section.expand();
      } else {
        await section.collapse();
      }
    }

    const rootFilesSection = await viewContent.getSection('根目录文件树');
    const filesystemRootItem = await rootFilesSection.findItem(path.parse(workspacePath).root, 1);
    assert.ok(filesystemRootItem, 'expected filesystem root item in root file tree');
    await filesystemRootItem.collapse();
    const shortcutItem = await rootFilesSection.findItem(path.basename(sandboxDir), 1);
    assert.ok(shortcutItem, 'expected refreshed quick path item in root file tree');
    await shortcutItem.expand();
    const uiFileItem = await shortcutItem.findChildItem(path.basename(uiOpenedFile));
    assert.ok(uiFileItem, 'expected file item below refreshed quick path');
    await collectUiSnapshot('root-file-tree-before-node-click');
    await uiFileItem.select();

    const openedFromTree = await waitForActiveEditor(
      editor => editor.fileName === uiOpenedFile,
      'file opened from refreshed root tree node'
    );
    assert.equal(openedFromTree.fileName, uiOpenedFile);
    const clickedSnapshot = await collectUiSnapshot('root-file-tree-after-node-click');
    assert.doesNotMatch(clickedSnapshot.document.visibleText, /Actual command not found/);

    await executeCommandOnFile(COMMANDS.rootFiles.removeQuickPath, sandboxDir);
  });
});

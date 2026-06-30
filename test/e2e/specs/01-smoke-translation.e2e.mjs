import assert from 'node:assert/strict';
import {
  COMMANDS,
  EXTENSION_ID,
  OPEN_NOTES_VIEW_COMMAND,
  REQUIRED_COMMANDS
} from '../support/extension-contract.mjs';
import { collectUiSnapshot, dumpExtensionState } from '../support/diagnostics.mjs';
import {
  cleanupWorkbench,
  files,
  installTranslationStub,
  notesPath,
  setupWorkbench,
  waitForActiveEditor
} from '../support/harness.mjs';

describe('Smart Page Translator smoke and translation E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('launches VS Code, activates the extension, opens Notes, and records a UI snapshot', async () => {
    const workbench = await browser.getWorkbench();
    const title = await workbench.getTitleBar().getTitle();
    assert.match(title, /Visual Studio Code|Code/);

    const state = await dumpExtensionState();
    assert.equal(state.extension?.id, EXTENSION_ID);
    assert.equal(state.extension?.isActive, true);
    assert.equal(state.configuration.notesLocation, notesPath);

    for (const command of REQUIRED_COMMANDS) {
      assert.ok(state.commands.includes(command), `expected command to be registered: ${command}`);
    }

    await browser.executeWorkbench(
      (vscode, command) => vscode.commands.executeCommand(command),
      OPEN_NOTES_VIEW_COMMAND
    );

    const snapshot = await collectUiSnapshot('workbench-notes-view');
    assert.ok(snapshot.elements.length > 0, 'expected workbench UI snapshot to contain visible nodes');
    assert.match(snapshot.document.visibleText, /Notes|Existing Note|existing\.md/);
  });

  it('translates the active file into an unsaved zh-CN editor with a deterministic E2E stub', async () => {
    const patch = await installTranslationStub();
    assert.equal(patch.patched, true, patch.error || 'expected deterministic translator to be enabled');

    await browser.executeWorkbench(async (vscode, args) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(args.file));
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(args.command);
    }, {
      file: files.translationInput,
      command: COMMANDS.translate
    });

    const translated = await waitForActiveEditor((editor) => (
      editor.scheme === 'untitled'
      && editor.fileName.endsWith('translation-input.zh-CN.txt')
      && editor.text.includes('[zh-Hans] Hello world')
    ), 'translated untitled zh-CN editor');

    assert.equal(translated.scheme, 'untitled');
    assert.ok(translated.fileName.endsWith('translation-input.zh-CN.txt'));
    assert.equal(translated.text, '[zh-Hans] Hello world\nSecond line\n');

    await collectUiSnapshot('translation-result-editor');
  });
});

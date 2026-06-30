import assert from 'node:assert/strict';
import { COMMANDS } from '../support/extension-contract.mjs';
import { collectUiSnapshot } from '../support/diagnostics.mjs';
import { cleanupWorkbench, files, setupWorkbench } from '../support/harness.mjs';

describe('Smart Page Translator terminal command E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('creates dedicated terminals for tsx and pytest command automation', async () => {
    const terminals = await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.runWithTsx, vscode.Uri.file(args.tsFile));
      await vscode.commands.executeCommand(args.runPytest, vscode.Uri.file(args.pyFile));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return vscode.window.terminals.map((terminal) => terminal.name);
    }, {
      runWithTsx: COMMANDS.runWithTsx,
      runPytest: COMMANDS.runPytest,
      tsFile: files.tsRunner,
      pyFile: files.pySample
    });

    assert.ok(terminals.includes('tsx'), `expected tsx terminal, got: ${terminals.join(', ')}`);
    assert.ok(terminals.includes('pytest'), `expected pytest terminal, got: ${terminals.join(', ')}`);

    await collectUiSnapshot('terminal-commands');
  });
});

import assert from 'node:assert/strict';
import { COMMANDS } from '../support/extension-contract.mjs';
import { cleanupWorkbench, files, setupWorkbench } from '../support/harness.mjs';

describe('Smart Page Translator AST E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('extracts a TypeScript AST outline and copies it to the clipboard', async () => {
    const outline = await browser.executeWorkbench(async (vscode, args) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(args.file));
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand(args.extractCommand);
      return vscode.commands.executeCommand(args.stateCommand);
    }, {
      file: files.astSample,
      extractCommand: COMMANDS.extractAstOutline,
      stateCommand: COMMANDS.internal.getLastAstOutline
    });

    assert.match(outline, /FILE /);
    assert.match(outline, /export class Greeter/);
    assert.match(outline, /method greet\(message: string\): string/);
    assert.match(outline, /export fn sum\(left: number, right: number\): number/);
  });
});

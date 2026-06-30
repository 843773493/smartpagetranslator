import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../support/extension-contract.mjs';
import {
  cleanupWorkbench,
  executeCommandWithInput,
  executeCommandWithWarningChoice,
  executeListNotesWithChoice,
  files,
  notesPath,
  setupWorkbench,
  waitForActiveEditor,
  waitForPath
} from '../support/harness.mjs';

describe('Smart Page Translator Notes E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('runs Notes commands through VS Code prompts and validates filesystem results', async () => {
    await browser.executeWorkbench(
      (vscode, command) => vscode.commands.executeCommand(command),
      COMMANDS.notes.refreshNotes
    );

    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.command, args.file);
    }, {
      command: COMMANDS.notes.openNote,
      file: files.existingNote
    });

    const openedExisting = await waitForActiveEditor(
      (editor) => editor.fileName === files.existingNote && editor.text.includes('Existing Note'),
      'existing note editor'
    );
    assert.equal(openedExisting.fileName, files.existingNote);

    const createdNote = path.join(notesPath, 'e2e-note.md');
    const renamedNote = path.join(notesPath, 'renamed-e2e-note.md');
    const createdFolder = path.join(notesPath, 'e2e-folder');
    const renamedFolder = path.join(notesPath, 'renamed-e2e-folder');

    await executeCommandWithInput(COMMANDS.notes.newNote, 'e2e-note');
    await waitForPath(createdNote, true);
    assert.equal(fs.readFileSync(createdNote, 'utf8'), '# e2e-note\n\n');

    await executeCommandWithInput(COMMANDS.notes.newFolder, 'e2e-folder');
    await waitForPath(createdFolder, true);

    await executeCommandWithInput(COMMANDS.notes.renameNote, 'renamed-e2e-note', {
      name: 'e2e-note.md',
      location: notesPath,
      isFolder: false
    });
    await waitForPath(renamedNote, true);
    assert.equal(fs.existsSync(createdNote), false);

    await executeCommandWithInput(COMMANDS.notes.renameFolder, 'renamed-e2e-folder', {
      name: 'e2e-folder',
      location: notesPath,
      isFolder: true
    });
    await waitForPath(renamedFolder, true);
    assert.equal(fs.existsSync(createdFolder), false);

    await executeCommandWithWarningChoice(COMMANDS.notes.deleteNote, '是', {
      name: 'renamed-e2e-note.md',
      location: notesPath,
      isFolder: false
    });
    await waitForPath(renamedNote, false);

    await executeCommandWithWarningChoice(COMMANDS.notes.deleteFolder, '是', {
      name: 'renamed-e2e-folder',
      location: notesPath,
      isFolder: true
    });
    await waitForPath(renamedFolder, false);

    await executeListNotesWithChoice('existing.md');
    const listedNote = await waitForActiveEditor(
      (editor) => editor.fileName === files.existingNote,
      'listed existing note editor'
    );
    assert.equal(listedNote.fileName, files.existingNote);
  });
});

import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    test('should register the main commands', async () => {
        const visibleExtensions = vscode.extensions.all.map(item => item.id);
        console.log('[test] visible extensions:', visibleExtensions.join(', '));

        const extensionId = '843773493.smart-page-translator';
        const extension = vscode.extensions.getExtension(extensionId);
        console.log('[test] getExtension result:', extension ? extension.id : 'null');

        assert.ok(extension, 'Extension should be visible in the test host');

        try {
            await extension.activate();
        } catch (err) {
            throw err;
        }

        const commands = await vscode.commands.getCommands(true);

        assert.ok(commands.includes('smartPageTranslator.translate'));
        assert.ok(commands.includes('smartPageTranslator.extractAstOutline'));
        assert.ok(commands.includes('smartPageTranslator.runWithTsx'));
        assert.ok(commands.includes('smartPageTranslator.runPytest'));
    });
});





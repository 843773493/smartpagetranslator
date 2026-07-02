import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOM_EDITORS,
  COMMANDS,
  EXTENSION_ID
} from '../support/extension-contract.mjs';
import {
  clickSelectorInFrameContainingSelector,
  readVisibleTextFromFrameContainingSelector
} from '../support/diagnostics.mjs';
import {
  cleanupWorkbench,
  executeCommandOnFile,
  files,
  setupWorkbench,
  workspacePath
} from '../support/harness.mjs';

describe('Smart Page Translator HTML preview E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('renders html files through the preview command and browser tools', async () => {
    const htmlContribution = await browser.executeWorkbench(
      async (vscode, args) => {
        const extension = vscode.extensions.getExtension(args.extensionId);
        await extension?.activate();
        const packageJSON = extension?.packageJSON;
        const explorerMenus = packageJSON?.contributes?.menus?.['explorer/context'] || [];
        const editorTitleMenus = packageJSON?.contributes?.menus?.['editor/title/context'] || [];
        const editorContextMenus = packageJSON?.contributes?.menus?.['editor/context'] || [];
        const customEditors = packageJSON?.contributes?.customEditors || [];
        const commands = await vscode.commands.getCommands(true);
        return {
          commandRegistered: commands.includes(args.previewCommand),
          customEditorRegistered: customEditors.some((item) => item.viewType === args.customEditor),
          explorerMenuRegistered: explorerMenus.some((item) => item.command === args.previewCommand),
          editorTitleMenuRegistered: editorTitleMenus.some((item) => item.command === args.previewCommand),
          editorContextMenuRegistered: editorContextMenus.some((item) => item.command === args.previewCommand)
        };
      },
      {
        extensionId: EXTENSION_ID,
        previewCommand: COMMANDS.rootFiles.previewHtml,
        customEditor: CUSTOM_EDITORS.htmlPreview
      }
    );
    assert.equal(htmlContribution.commandRegistered, true);
    assert.equal(htmlContribution.customEditorRegistered, true);
    assert.equal(htmlContribution.explorerMenuRegistered, true);
    assert.equal(htmlContribution.editorTitleMenuRegistered, true);
    assert.equal(htmlContribution.editorContextMenuRegistered, true);

    // TODO: 当前 WDIO executeWorkbench 调用 vscode.openWith 会触发 VS Code 测试窗口卸载，
    // 后续需要改用稳定的 UI 自动化路径验证 Open With 实际打开 Custom Editor。

    const oldExportDir = path.join(workspacePath, 'browser-e2e-output');
    fs.rmSync(oldExportDir, { recursive: true, force: true });

    await executeCommandOnFile(COMMANDS.rootFiles.previewHtml, files.htmlPreview);

    let visibleText = '';
    await browser.waitUntil(async () => {
      try {
        visibleText = await readVisibleTextFromFrameContainingSelector('#html-preview-e2e-message');
        return visibleText.includes('HTML 预览标题')
          && visibleText.includes('Smart Page Translator HTML 渲染成功');
      } catch {
        return false;
      }
    }, {
      timeout: 20000,
      interval: 300,
      timeoutMsg: 'Timed out waiting for rendered HTML preview content'
    });

    assert.match(visibleText, /HTML 预览标题/);
    assert.match(visibleText, /Smart Page Translator HTML 渲染成功/);
    assert.doesNotMatch(visibleText, /区域截图/);
    assert.doesNotMatch(visibleText, /截图/);

    await clickSelectorInFrameContainingSelector('#inspect-button', '#inspect-button');
    await clickSelectorInFrameContainingSelector('#html-preview-e2e-message', '#html-preview-e2e-message');
    const afterSelectionText = await readVisibleTextFromFrameContainingSelector('#html-preview-e2e-message');
    assert.doesNotMatch(afterSelectionText, /已选元素\s*选择器/);
    const selectedElementClipboard = await waitForClipboardState({
      includes: 'html-preview-e2e-message',
      textLimit: 2000
    });
    assert.match(selectedElementClipboard.text, /<p[^>]+id="html-preview-e2e-message"/);

    const logsClipboard = await browser.executeWorkbench(
      async (vscode, args) => {
        const copied = await vscode.commands.executeCommand(args.command);
        const clipboard = await vscode.env.clipboard.readText();
        return {
          clipboardEqualsCommandResult: clipboard === copied,
          text: String(copied || '')
        };
      },
      {
        command: COMMANDS.browser.exportLogs
      }
    );
    const logs = JSON.parse(logsClipboard.text);
    assert.equal(logsClipboard.clipboardEqualsCommandResult, true);
    assert.equal(Array.isArray(logs), true);
    assert.equal(logs.some((entry) => entry.message.includes('HTML 预览 fixture 日志')), true);
    assert.equal(fs.existsSync(oldExportDir), false);
  });
});

async function waitForClipboardState(options) {
  let state;
  await browser.waitUntil(async () => {
    state = await browser.executeWorkbench(async (vscode, args) => {
      const text = await vscode.env.clipboard.readText();
      return {
        includes: args.includes ? text.includes(args.includes) : true,
        length: text.length,
        startsWith: args.startsWith ? text.startsWith(args.startsWith) : true,
        text: text.slice(0, args.textLimit)
      };
    }, {
      includes: options.includes,
      startsWith: options.startsWith,
      textLimit: options.textLimit || 120
    });
    return state.includes && state.startsWith;
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: 'Timed out waiting for browser export clipboard content'
  });
  return state;
}

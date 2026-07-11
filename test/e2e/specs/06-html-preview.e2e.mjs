import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOM_EDITORS,
  COMMANDS,
  EXTENSION_ID
} from '../support/extension-contract.mjs';
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

    await waitForBrowserState({
      mode: 'html',
      urlIncludes: '/html-preview.html'
    });
    const selectedElementClipboard = await selectBrowserElementBySelector('#html-preview-e2e-message', {
      includes: 'html-preview-e2e-message',
      textLimit: 2000
    });
    assert.match(selectedElementClipboard.text, /<p[^>]+id="html-preview-e2e-message"/);
    assert.match(selectedElementClipboard.text, /Smart Page Translator HTML 渲染成功/);
    assert.doesNotMatch(selectedElementClipboard.text, /区域截图|截图|已选元素\s*选择器/);

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

async function waitForBrowserState(options) {
  let state;
  await browser.waitUntil(async () => {
    try {
      state = await browser.executeWorkbench((vscode, command) => (
        vscode.commands.executeCommand(command)
      ), COMMANDS.internal.getBrowserState);
      return state.active?.mode === options.mode
        && state.active?.url?.includes(options.urlIncludes);
    } catch {
      return false;
    }
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for browser state ${JSON.stringify(options)}; last state ${JSON.stringify(state)}`
  });
  return state;
}

async function selectBrowserElementBySelector(selector, clipboardOptions) {
  let state;
  await browser.waitUntil(async () => {
    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.command, args.selector);
    }, {
      command: COMMANDS.internal.selectBrowserElementBySelector,
      selector
    });

    state = await readClipboardState(clipboardOptions);
    return state.includes && state.startsWith;
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for selected browser element ${selector}`
  });
  return state;
}

async function waitForClipboardState(options) {
  let state;
  await browser.waitUntil(async () => {
    state = await readClipboardState(options);
    return state.includes && state.startsWith;
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: 'Timed out waiting for browser export clipboard content'
  });
  return state;
}

async function readClipboardState(options) {
  return browser.executeWorkbench(async (vscode, args) => {
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
}

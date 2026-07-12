import assert from 'node:assert/strict';
import { COMMANDS } from '../support/extension-contract.mjs';
import {
  cleanupWorkbench,
  executeCommandWithInput,
  setupWorkbench
} from '../support/harness.mjs';

describe('Smart Page Translator integrated browser error E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('renders a selectable error document when the target cannot be loaded', async () => {
    const unreachableUrl = 'http://127.0.0.1:1/';
    await executeCommandWithInput(COMMANDS.browser.openUrl, unreachableUrl);

    let state;
    await browser.waitUntil(async () => {
      state = await readBrowserState();
      return state.active?.url === unreachableUrl;
    }, {
      timeout: 20000,
      interval: 300,
      timeoutMsg: `Timed out waiting for browser error document; last state ${JSON.stringify(state)}`
    });

    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.command, args.selector, { copyToClipboard: false });
    }, {
      command: COMMANDS.internal.selectBrowserElementBySelector,
      selector: '#smart-page-translator-load-error'
    });

    await browser.waitUntil(async () => {
      state = await readBrowserState();
      return state.active?.selectedElement?.id === 'smart-page-translator-load-error';
    }, {
      timeout: 20000,
      interval: 300,
      timeoutMsg: `Timed out selecting browser error document; last state ${JSON.stringify(state)}`
    });

    assert.match(state.active?.selectedElement?.text || '', /网页加载失败/);
    assert.match(state.active?.selectedElement?.outerHTML || '', /127\.0\.0\.1:1/);
  });
});

async function readBrowserState() {
  return browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.getBrowserState);
}

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

  it('keeps a proxied browser panel active when the target cannot be loaded', async () => {
    const unreachableUrl = 'http://127.0.0.1:1/';
    await executeCommandWithInput(COMMANDS.browser.openUrl, unreachableUrl);

    let state;
    await browser.waitUntil(async () => {
      state = await readBrowserState();
      return state.active?.url === unreachableUrl
        && state.active?.webviewUrl === unreachableUrl
        && state.active?.recentLogs?.some(entry => entry.message === 'Proxy relay shell ready');
    }, {
      timeout: 20000,
      interval: 300,
      timeoutMsg: `Timed out waiting for browser error document; last state ${JSON.stringify(state)}`
    });

    assert.equal(state.active?.mode, 'url');
    assert.equal(state.active?.webviewUrl, unreachableUrl);
    assert.match(state.active?.proxyUrl || '', /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.ok(state.active?.recentLogs?.some(entry => entry.message === 'Proxy relay shell ready'));
  });
});

async function readBrowserState() {
  return browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.getBrowserState);
}

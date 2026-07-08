import assert from 'node:assert/strict';
import http from 'node:http';
import {
  COMMANDS,
  EXTENSION_ID
} from '../support/extension-contract.mjs';
import {
  cleanupWorkbench,
  executeCommandWithInput,
  setupWorkbench
} from '../support/harness.mjs';

describe('Smart Page Translator integrated browser E2E', () => {
  beforeEach(setupWorkbench);
  afterEach(cleanupWorkbench);

  it('opens the standalone browser command from F1 and switches ordinary HTTP URLs', async () => {
    const browserContribution = await browser.executeWorkbench(
      async (vscode, args) => {
        const extension = vscode.extensions.getExtension(args.extensionId);
        await extension?.activate();
        const packageJSON = extension?.packageJSON;
        const commands = await vscode.commands.getCommands(false);
        const commandContribution = packageJSON?.contributes?.commands?.find((item) => (
          item.command === args.openUrlCommand
        ));
        const commandPaletteMenu = packageJSON?.contributes?.menus?.commandPalette?.find((item) => (
          item.command === args.openUrlCommand
        ));

        return {
          publicCommandRegistered: commands.includes(args.openUrlCommand),
          title: commandContribution?.title,
          category: commandContribution?.category,
          commandPaletteRegistered: Boolean(commandPaletteMenu),
          commandPaletteHidden: commandPaletteMenu?.when === 'false'
        };
      },
      {
        extensionId: EXTENSION_ID,
        openUrlCommand: COMMANDS.browser.openUrl
      }
    );
    assert.equal(browserContribution.publicCommandRegistered, true);
    assert.equal(browserContribution.title, '打开网页');
    assert.equal(browserContribution.category, '集成浏览器');
    assert.equal(browserContribution.commandPaletteRegistered, true);
    assert.equal(browserContribution.commandPaletteHidden, false);

    const server = await startHttpFixtureServer();
    try {
      const firstUrl = `${server.origin}/first`;
      await executeCommandWithInput(COMMANDS.browser.openUrl, firstUrl);
      const firstState = await waitForBrowserState(firstUrl);
      assert.equal(firstState.active?.url, firstUrl);
      assert.equal(browserUrlPanels(firstState).length, 1);
      await waitForServerRequest(server, '/first');

      const secondUrl = `${server.origin}/second`;
      await executeCommandWithInput(COMMANDS.browser.openUrl, secondUrl);
      const secondState = await waitForBrowserState(secondUrl);
      assert.equal(secondState.active?.url, secondUrl);
      assert.equal(browserUrlPanels(secondState).length, 1);
      await waitForServerRequest(server, '/second');
    } finally {
      await server.close();
      await closeStandaloneBrowser();
    }
  });
});

async function startHttpFixtureServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const route = request.url?.replace(/^\//, '') || 'root';
    requests.push(request.url || '/');
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>HTTP fixture ${route}</title></head>
<body>
  <h1 id="browser-http-e2e-message">HTTP fixture ${route}</h1>
</body>
</html>`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP fixture server did not expose a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    })
  };
}

async function waitForBrowserState(expectedUrl) {
  let state;
  await browser.waitUntil(async () => {
    try {
      state = await readBrowserState();
      return state.active?.url === expectedUrl && browserUrlPanels(state).length === 1;
    } catch {
      return false;
    }
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for browser URL ${expectedUrl}`
  });
  return state;
}

async function readBrowserState() {
  return browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.getBrowserState);
}

async function closeStandaloneBrowser() {
  await browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.closeStandaloneBrowser);
}

async function waitForServerRequest(server, pathname) {
  await browser.waitUntil(() => server.requests.includes(pathname), {
    timeout: 20000,
    interval: 200,
    timeoutMsg: `Timed out waiting for HTTP fixture request ${pathname}; received ${server.requests.join(', ')}`
  });
}

function browserUrlPanels(state) {
  return state.panels.filter((panel) => panel.key === 'standalone-browser');
}

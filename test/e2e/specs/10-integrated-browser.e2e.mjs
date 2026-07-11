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

  it('opens proxied standalone browser URLs, runs page scripts, and selects page elements', async () => {
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
      const redirectUrl = `${server.origin}/client-redirect`;
      await executeCommandWithInput(COMMANDS.browser.openUrl, redirectUrl);
      const firstState = await waitForBrowserState(firstUrl);
      assert.equal(firstState.active?.url, firstUrl);
      assert.equal(browserUrlPanels(firstState).length, 1);
      await waitForServerRequest(server, request => request.pathname === '/first', '/first document');
      await waitForServerRequest(server, request => request.pathname === '/client-redirect', 'client redirect document');
      await waitForServerRequest(server, request => request.pathname === '/@vite/client', '/@vite/client module');
      await waitForServerRequest(server, request => request.pathname === '/src/dependency.js', 'nested ES module dependency');
      await waitForServerRequest(server, request => request.pathname === '/styles/main.css', 'page stylesheet');
      await waitForServerRequest(server, request => request.pathname === '/styles/nested.css', 'nested CSS import');
      await waitForServerRequest(server, request => request.pathname === '/assets/pixel.svg', 'CSS image resource');
      await waitForServerRequest(server, request => (
        request.pathname === '/script-executed' && request.searchParams.get('from') === '/first'
      ), 'module script execution for /first');

      await selectBrowserElementBySelector('#browser-http-e2e-message');
      const selectedState = await waitForSelectedElement('#browser-http-e2e-message');
      assert.equal(selectedState.active?.selectedElement?.tagName, 'h1');
      assert.equal(selectedState.active?.selectedElement?.id, 'browser-http-e2e-message');
      assert.match(selectedState.active?.selectedElement?.outerHTML || '', /HTTP fixture first/);
    } finally {
      await closeStandaloneBrowser();
      await server.close();
    }
  });
});

async function startHttpFixtureServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url);

    if (url.pathname === '/@vite/client') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end('window.__smartPageTranslatorViteClientLoaded = true;');
      return;
    }

    if (url.pathname === '/src/main.tsx') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`
		import { message } from './dependency.js';
        document.body.dataset.smartPageTranslatorModule = 'executed';
		document.getElementById('browser-http-e2e-message').textContent = message;
        fetch('/script-executed?from=' + encodeURIComponent(new URL(document.baseURI).pathname), { cache: 'no-store' });
      `);
      return;
    }

    if (url.pathname === '/src/dependency.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`export const message = 'HTTP fixture first nested module';`);
      return;
    }

    if (url.pathname === '/styles/main.css') {
      response.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`@import './nested.css'; body { background-image: url('../assets/pixel.svg'); }`);
      return;
    }

    if (url.pathname === '/styles/nested.css') {
      response.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`#browser-http-e2e-message { color: rgb(1, 2, 3); }`);
      return;
    }

    if (url.pathname === '/assets/pixel.svg') {
      response.writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'no-store'
      });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>`);
      return;
    }

    if (url.pathname === '/script-executed') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (url.pathname === '/client-redirect') {
      const address = server.address();
      const origin = address && typeof address !== 'string'
        ? `http://127.0.0.1:${address.port}`
        : 'http://127.0.0.1';
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`<html><head><script>location.replace('${origin}/first');</script></head><body></body></html>`);
      return;
    }

    const route = url.pathname.replace(/^\//, '') || 'root';
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>HTTP fixture ${route}</title><link rel="stylesheet" href="/styles/main.css"></head>
<body>
  <h1 id="browser-http-e2e-message">HTTP fixture ${route}</h1>
  <script type="module" src="/@vite/client"></script>
  <script type="module" src="/src/main.tsx"></script>
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
      return state.active?.url === expectedUrl
        && state.active?.webviewUrl === expectedUrl
        && browserUrlPanels(state).length === 1;
    } catch {
      return false;
    }
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for browser URL ${expectedUrl}; last state ${JSON.stringify(state)}`
  });
  return state;
}

async function readBrowserState() {
  return browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.getBrowserState);
}

async function selectBrowserElementBySelector(selector) {
  await browser.executeWorkbench(async (vscode, args) => {
    await vscode.commands.executeCommand(args.command, args.selector, { copyToClipboard: false });
  }, {
    command: COMMANDS.internal.selectBrowserElementBySelector,
    selector
  });
}

async function closeStandaloneBrowser() {
  try {
    await browser.executeWorkbench((vscode, command) => (
      vscode.commands.executeCommand(command)
    ), COMMANDS.internal.closeStandaloneBrowser);
  } catch {
    // VS Code Insiders 有时会在 URL Webview 重渲染后先关闭测试窗口；清理阶段不覆盖主断言结果。
  }
}

async function waitForServerRequest(server, predicate, label) {
  await browser.waitUntil(() => server.requests.some(predicate), {
    timeout: 20000,
    interval: 200,
    timeoutMsg: `Timed out waiting for HTTP fixture request ${label}; received ${server.requests.map(formatRequest).join(', ')}`
  });
}

function browserUrlPanels(state) {
  return state.panels.filter((panel) => panel.key === 'standalone-browser');
}

function formatRequest(request) {
  return `${request.pathname}${request.search}`;
}

async function waitForSelectedElement(selector) {
  let state;
  await browser.waitUntil(async () => {
    state = await readBrowserState();
    return state.active?.selectedElement?.selector === selector
      || state.active?.selectedElement?.id === selector.replace(/^#/, '');
  }, {
    timeout: 20000,
    interval: 300,
    timeoutMsg: `Timed out waiting for browser selected element ${selector}; last state ${JSON.stringify(state)}`
  });
  return state;
}

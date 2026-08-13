import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  COMMANDS,
  EXTENSION_ID
} from '../support/extension-contract.mjs';
import {
  cleanupWorkbench,
  executeCommandWithInput,
  setupWorkbench
} from '../support/harness.mjs';
import {
  clickSelectorInFrameContainingSelector,
  switchToFrameContainingSelector,
  switchToTopFrame
} from '../support/diagnostics.mjs';

const realBrowserUrl = process.env.SPT_E2E_BROWSER_URL;

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
      await waitForServerRequest(server, request => request.pathname === '/client-redirect', 'client redirect document');
      await waitForServerRequest(server, request => request.pathname === '/first', '/first document');
      const firstState = await waitForBrowserState(firstUrl);
      assert.equal(firstState.active?.url, firstUrl);
      assert.equal(browserUrlPanels(firstState).length, 1);
      await waitForServerRequest(server, request => (
        request.pathname === '/first' && request.cookie.includes('spt_session=e2e-session')
      ), 'document request with proxy session cookie');
      await waitForServerRequest(server, request => request.pathname === '/@vite/client', '/@vite/client module');
      await waitForServerRequest(server, request => (
        request.pathname === '/websocket-confirmed'
          && request.searchParams.get('message') === 'upstream-ready'
      ), 'proxied WebSocket server message');
      await waitForServerRequest(server, request => request.pathname === '/@react-refresh', 'inline module dependency');
      await waitForServerRequest(server, request => request.pathname === '/src/dependency.js', 'nested ES module dependency');
      await waitForServerRequest(server, request => request.pathname === '/styles/main.css', 'page stylesheet');
      await waitForServerRequest(server, request => request.pathname === '/styles/nested.css', 'nested CSS import');
      await waitForServerRequest(server, request => request.pathname === '/assets/pixel.svg', 'CSS image resource');
      await waitForServerRequest(server, request => request.pathname === '/assets/test-font.woff2', 'Vite-injected CSS font resource');
      await waitForServerRequest(server, request => (
        request.pathname === '/iframe-confirmed'
          && request.searchParams.get('text') === 'static-child-ready'
      ), 'same-origin static iframe access');
      await waitForServerRequest(server, request => (
        request.pathname === '/script-executed'
          && request.searchParams.get('from') === '/first'
          && request.searchParams.get('eval') === '42'
          && request.cookie.includes('spt_session=e2e-session')
      ), 'module script execution for /first');
      await waitForServerRequest(server, request => (
		request.pathname === '/frame-access-confirmed'
		  && request.searchParams.get('kind') === 'static'
		  && request.searchParams.get('path') === '/frame-child'
	  ), 'same-origin static iframe access');
	  await waitForServerRequest(server, request => (
		request.pathname === '/frame-access-confirmed'
		  && request.searchParams.get('kind') === 'dynamic'
		  && request.searchParams.get('path') === '/frame-child'
	  ), 'same-origin dynamic iframe access');
	  await waitForServerRequest(server, request => request.pathname === '/picker-control-confirmed', 'iframe picker control');
	  await waitForServerRequest(server, request => request.pathname === '/picker-click-triggered', 'iframe picker click');
	  await browser.waitUntil(async () => {
		const state = await readBrowserState();
		return state.active?.recentLogs?.some(entry => entry.message === 'Synthetic child relay confirmed');
	  }, { timeout: 10000, interval: 200, timeoutMsg: 'Child-frame bridge result did not relay to the outer Webview' });

      const selectedChildState = await waitForSelectedElement('#iframe-child-message');
      assert.equal(selectedChildState.active?.selectedElement?.id, 'iframe-child-message');
      assert.match(selectedChildState.active?.selectedElement?.text || '', /static-child-ready/);
    } finally {
      await closeStandaloneBrowser();
      await server.close();
    }
  });

  (realBrowserUrl ? it : it.skip)('opens a configured real URL and selects an element through mouse input', async () => {
    await executeCommandWithInput(COMMANDS.browser.openUrl, realBrowserUrl);
    await waitForBrowserState(realBrowserUrl);

    await browser.waitUntil(async () => {
      try {
        await clickSelectorInFrameContainingSelector(
          '#smart-page-translator-browser-toolbar',
          '#inspect-button'
        );
        await clickSelectorInFrameContainingSelector(
          '#smart-page-translator-browser-toolbar',
          '#root *'
        );
        const state = await readBrowserState();
        return Boolean(state.active?.selectedElement?.selector);
      } catch {
        return false;
      }
    }, {
      timeout: 30000,
      interval: 500,
      timeoutMsg: `Timed out selecting a real page element from ${realBrowserUrl}`
    });

    const state = await readBrowserState();
    assert.equal(state.active?.url, realBrowserUrl);
    assert.ok(state.active?.selectedElement?.selector);

    await switchToTopFrame();
    const foundPageFrame = await switchToFrameContainingSelector('#smart-page-translator-browser-toolbar');
    assert.equal(foundPageFrame, true);
    try {
      await browser.waitUntil(() => browser.execute(() => document.fonts.check('16px codicon')), {
        timeout: 15000,
        interval: 300,
        timeoutMsg: `Timed out loading the codicon font from ${realBrowserUrl}`
      });
      const rootTop = await browser.execute(() => document.querySelector('#root')?.getBoundingClientRect().top);
      assert.ok(Number(rootTop) >= 36, `Expected page root below browser toolbar, got top=${rootTop}`);
    } finally {
      await switchToTopFrame();
    }

    const exportedLogs = await browser.executeWorkbench((vscode, command) => (
      vscode.commands.executeCommand(command)
    ), COMMANDS.browser.exportLogs);
    const pageLogs = JSON.parse(String(exportedLogs || '[]'));
    assert.equal(pageLogs.some(entry => entry.message.includes('[vite] failed to connect to websocket')), false);
  });
});

async function startHttpFixtureServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    url.cookie = request.headers.cookie || '';
    requests.push(url);

    if (url.pathname === '/@vite/client') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`
        window.__smartPageTranslatorViteClientLoaded = true;
        const socketUrl = new URL(import.meta.url);
        socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        socketUrl.pathname = '/hmr-test';
        socketUrl.search = '';
        const socket = new WebSocket(socketUrl);
        socket.addEventListener('open', () => socket.send('browser-ready'));
        socket.addEventListener('message', event => {
          fetch('/websocket-confirmed?message=' + encodeURIComponent(String(event.data)), { cache: 'no-store' });
          socket.close();
        });
      `);
      return;
    }

    if (url.pathname === '/@react-refresh') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`export function injectIntoGlobalHook() { window.__smartPageTranslatorInlineModuleLoaded = true; }`);
      return;
    }

    if (url.pathname === '/src/main.tsx') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`
		import { message } from './dependency.js';
		import '/styles/vite-font.css';
        document.body.dataset.smartPageTranslatorModule = 'executed';
		document.getElementById('browser-http-e2e-message').textContent = message;
        const evaluated = eval('21 * 2');
        fetch('/script-executed?from=' + encodeURIComponent(new URL(document.baseURI).pathname) + '&eval=' + evaluated, { cache: 'no-store' });
        const reportFrame = (frame, endpoint) => {
          const report = () => {
            const href = frame.contentWindow.location.href;
            const text = frame.contentDocument.getElementById('iframe-child-message').textContent;
            fetch(endpoint + '?href=' + encodeURIComponent(href) + '&text=' + encodeURIComponent(text), { cache: 'no-store' });
          };
          if (frame.contentDocument && frame.contentDocument.readyState === 'complete') {
            report();
          } else {
            frame.addEventListener('load', report, { once: true });
          }
        };
        const pickerFrame = document.getElementById('static-child-frame');
        reportFrame(pickerFrame, '/iframe-confirmed');
        const exercisePicker = () => {
          const token = window.__smartPageTranslatorProxy && window.__smartPageTranslatorProxy.sessionToken;
          pickerFrame.contentWindow.postMessage({
            channel: 'smartPageTranslator.browser.control',
            token,
            type: 'setInspectMode',
            enabled: true
          }, '*');
          pickerFrame.contentWindow.postMessage({ type: 'trigger-e2e-picker-click' }, '*');
        };
        if (pickerFrame.contentDocument && pickerFrame.contentDocument.readyState === 'complete') {
          exercisePicker();
        } else {
          pickerFrame.addEventListener('load', exercisePicker, { once: true });
        }
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

    if (url.pathname === '/styles/vite-font.css') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`
        const __vite__css = '@font-face { font-family: "spt-test-font"; src: url("/assets/test-font.woff2") format("woff2"); } #browser-http-e2e-message { font-family: "spt-test-font"; }';
        const style = document.createElement('style');
        style.textContent = __vite__css;
        document.head.appendChild(style);
      `);
      return;
    }

    if (url.pathname === '/assets/test-font.woff2') {
      response.writeHead(200, {
        'content-type': 'font/woff2',
        'cache-control': 'no-store'
      });
      response.end(Buffer.from('wOF2-test-font-fixture'));
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

    if (url.pathname === '/websocket-confirmed') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (url.pathname === '/iframe-child' || url.pathname === '/iframe-dynamic') {
      const label = url.pathname === '/iframe-child' ? 'static-child-ready' : 'dynamic-child-ready';
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(`<!doctype html><html><body><button id="iframe-child-message">${label}</button><script>
        window.addEventListener('message', event => {
          if (event.data?.channel === 'smartPageTranslator.browser.control' && event.data?.type === 'setInspectMode') {
            fetch('/picker-control-confirmed', { cache: 'no-store' });
            if (event.data.enabled) {
              setTimeout(() => {
                fetch('/picker-click-triggered', { cache: 'no-store' });
                document.getElementById('iframe-child-message').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              }, 0);
            }
          }
          if (event.data?.type === 'trigger-e2e-picker-click') {
            const token = window.__smartPageTranslatorProxy && window.__smartPageTranslatorProxy.sessionToken;
            window.parent.postMessage({
              channel: 'smartPageTranslator.browser',
              token,
              payload: { type: 'pageLog', level: 'info', values: ['Synthetic child relay confirmed'] }
            }, '*');
          }
        });
      <\/script></body></html>`);
      return;
    }

    if (url.pathname === '/iframe-confirmed' || url.pathname === '/dynamic-iframe-confirmed') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (url.pathname === '/picker-control-confirmed' || url.pathname === '/picker-click-triggered') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

	if (url.pathname === '/frame-access-confirmed') {
	  response.writeHead(204, { 'cache-control': 'no-store' });
	  response.end();
	  return;
	}

	if (url.pathname === '/frame-child') {
	  response.writeHead(200, {
		'content-type': 'text/html; charset=utf-8',
		'cache-control': 'no-store'
	  });
	  response.end('<!doctype html><html><body><button id="nested-frame-target">Nested frame target</button></body></html>');
	  return;
	}

    if (url.pathname === '/client-redirect') {
      const address = server.address();
      const origin = address && typeof address !== 'string'
        ? `http://127.0.0.1:${address.port}`
        : 'http://127.0.0.1';
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': 'spt_session=e2e-session; Path=/; HttpOnly; SameSite=Lax'
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
<head><meta charset="utf-8"><title>HTTP fixture ${route}</title><link rel="stylesheet" href="/styles/main.css"><script type="module">import { injectIntoGlobalHook } from '/@react-refresh'; injectIntoGlobalHook(window);</script></head>
<body>
  <h1 id="browser-http-e2e-message">HTTP fixture ${route}</h1>
  <iframe id="static-child-frame" src="/iframe-child"></iframe>
	  <iframe id="static-frame" src="/frame-child"></iframe>
	  <script type="module" src="/@vite/client"></script>
	  <script type="module" src="/src/main.tsx"></script>
	  <script>
		const reportFrame = (kind, frame) => frame.addEventListener('load', () => {
		  void frame.contentWindow.location.href;
		  const path = new URL(frame.contentDocument.baseURI).pathname;
		  fetch('/frame-access-confirmed?kind=' + kind + '&path=' + encodeURIComponent(path));
		}, { once: true });
		reportFrame('static', document.getElementById('static-frame'));
		const dynamicFrame = document.createElement('iframe');
		dynamicFrame.id = 'dynamic-frame';
		reportFrame('dynamic', dynamicFrame);
		dynamicFrame.src = '/frame-child';
		document.body.appendChild(dynamicFrame);
	  </script>
	</body>
</html>`);
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/hmr-test') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, client => {
      client.send('upstream-ready');
      client.on('message', message => {
        if (String(message) === 'browser-ready') {
          client.send('browser-echo');
        }
      });
    });
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
      webSocketServer.close(() => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    })
  };
}

async function waitForBrowserState(expectedUrl) {
  let state;
  try {
    await browser.waitUntil(async () => {
      try {
        state = await readBrowserState();
        return state.active?.url === expectedUrl
          && state.active?.webviewUrl === expectedUrl
          && browserUrlPanels(state).length === 1;
	  } catch (error) {
	    state = { readError: String(error?.stack || error) };
        return false;
      }
    }, {
      timeout: 20000,
      interval: 300
    });
  } catch (error) {
    throw new Error(`Timed out waiting for browser URL ${expectedUrl}; last state ${JSON.stringify(state)}`, { cause: error });
  }
  return state;
}

async function readBrowserState() {
  return browser.executeWorkbench((vscode, command) => (
    vscode.commands.executeCommand(command)
  ), COMMANDS.internal.getBrowserState);
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
  let readError;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      state = await readBrowserState();
      readError = undefined;
      if (state.active?.selectedElement?.selector === selector
        || state.active?.selectedElement?.id === selector.replace(/^#/, '')) {
        return state;
      }
    } catch (error) {
      readError = String(error?.stack || error);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for browser selected element ${selector}; last state ${JSON.stringify({ state, readError })}`);
}

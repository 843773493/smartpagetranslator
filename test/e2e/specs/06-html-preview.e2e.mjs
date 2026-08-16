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
import {
  clickSelectorInFrameContainingSelector,
  switchToFrameContainingSelector,
  switchToTopFrame
} from '../support/diagnostics.mjs';

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
          editorTitleMenu: editorTitleMenus.find((item) => item.command === args.previewCommand),
          editorContextMenu: editorContextMenus.find((item) => item.command === args.previewCommand)
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
    assert.equal(htmlContribution.editorTitleMenu?.group, '2_smartPageTranslator@1');
    assert.equal(htmlContribution.editorContextMenu?.group, '2_smartPageTranslator@1');

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
    }, {
      verifyHighlightOverlay: true
    });
    assert.match(selectedElementClipboard.text, /<p[^>]+id="html-preview-e2e-message"/);
    assert.match(selectedElementClipboard.text, /Smart Page Translator HTML 渲染成功/);
    assert.doesNotMatch(selectedElementClipboard.text, /区域截图|截图|已选元素\s*选择器/);

    await browser.waitUntil(async () => {
      const state = await browser.executeWorkbench((vscode, command) => (
        vscode.commands.executeCommand(command)
      ), COMMANDS.internal.getBrowserState);
      return state.active?.recentLogs?.some(entry => (
        entry.message === 'Independent highlight overlay verification: passed'
      ));
    }, {
      timeout: 10000,
      interval: 200,
      timeoutMsg: 'Independent highlight overlay verification did not pass'
    });

    await switchToTopFrame();
    assert.equal(await switchToFrameContainingSelector('#smart-page-translator-browser-toolbar'), true);
    try {
      const layout = await browser.execute(() => ({
        bodyTransform: getComputedStyle(document.body).transform,
        bodyPosition: getComputedStyle(document.body).position,
        bodyMarginTop: getComputedStyle(document.body).marginTop,
        bodyMarginBottom: getComputedStyle(document.body).marginBottom,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        bodyRect: (() => {
          const rect = document.body.getBoundingClientRect();
          return {
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        })(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollHeight: document.body.scrollHeight,
        bodyClientHeight: document.body.clientHeight,
        htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
        htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
        htmlScrollWidth: document.documentElement.scrollWidth,
        htmlClientWidth: document.documentElement.clientWidth,
        htmlScrollHeight: document.documentElement.scrollHeight,
        htmlClientHeight: document.documentElement.clientHeight
      }));
      assert.equal(layout.bodyTransform, 'none');
      assert.equal(layout.bodyPosition, 'fixed');
      assert.equal(layout.bodyMarginTop, '0px');
      assert.equal(layout.bodyMarginBottom, '0px');
      assert.equal(layout.bodyOverflowX, 'auto');
      assert.equal(layout.bodyOverflowY, 'auto');
      assert.equal(layout.bodyRect.top, 37);
      assert.equal(layout.bodyRect.right, layout.viewportWidth);
      assert.equal(layout.bodyRect.bottom, layout.viewportHeight);
      assert.equal(layout.bodyRect.height, layout.viewportHeight - 37);
      assert.ok(layout.bodyScrollWidth <= layout.bodyClientWidth);
      assert.ok(layout.bodyScrollHeight >= layout.bodyClientHeight);
      assert.equal(layout.htmlOverflowX, 'hidden');
      assert.equal(layout.htmlOverflowY, 'hidden');
      assert.ok(layout.htmlScrollWidth <= layout.htmlClientWidth);
      assert.ok(layout.htmlScrollHeight <= layout.htmlClientHeight);

      const zoomResult = await browser.execute(() => {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100
        });
        window.dispatchEvent(event);
        return {
          defaultPrevented: event.defaultPrevented,
          zoom: document.body.style.zoom
        };
      });
      assert.equal(zoomResult.defaultPrevented, true);
      assert.equal(zoomResult.zoom, '1.1');

      const horizontalScroll = await browser.execute(() => {
        const probe = document.createElement('div');
        probe.id = 'spt-horizontal-scroll-probe';
        probe.style.width = '1400px';
        probe.style.height = '1px';
        probe.style.pointerEvents = 'none';
        document.body.appendChild(probe);
        const result = {
          overflowX: getComputedStyle(document.body).overflowX,
          scrollWidth: document.body.scrollWidth,
          clientWidth: document.body.clientWidth
        };
        document.body.scrollLeft = document.body.scrollWidth;
        result.scrollLeft = document.body.scrollLeft;
        probe.remove();
        document.body.scrollLeft = 0;
        return result;
      });
      assert.equal(horizontalScroll.overflowX, 'auto');
      assert.ok(horizontalScroll.scrollWidth > horizontalScroll.clientWidth);
      assert.ok(horizontalScroll.scrollLeft > 0);
    } finally {
      await browser.execute(() => {
        document.body.style.zoom = '';
      });
      await switchToTopFrame();
    }

    const fullElementContextChecks = await browser.executeWorkbench(async (vscode, command) => {
      const text = String(await vscode.commands.executeCommand(command) || '');
      return {
        hasHeader: /^Attached Element Context from Integrated Browser/.test(text),
        hasElement: /Element: p/.test(text),
        hasUrl: /URL: /.test(text),
        hasPath: /HTML Path: /.test(text),
        hasOuterHtml: /Outer HTML:\n```html/.test(text),
        hasSelectedElement: /<p[^>]+id="html-preview-e2e-message"/.test(text),
        hasDimensions: /Dimensions:\n- top: /.test(text),
        hasCss: /CSS:\n```css/.test(text),
        hasResolvedValues: /\/\* Resolved values \*\//.test(text),
        hasInheritedValues: /\/\* Inherited \*\//.test(text),
        hasDisplayValue: /display:\s/.test(text),
        hasNoUnrelatedComputedValues: !/animation-composition:|scroll-target-group:/.test(text)
      };
    }, COMMANDS.internal.getSelectedBrowserElementContext);
    assert.deepEqual(fullElementContextChecks, {
      hasHeader: true,
      hasElement: true,
      hasUrl: true,
      hasPath: true,
      hasOuterHtml: true,
      hasSelectedElement: true,
      hasDimensions: true,
      hasCss: true,
      hasResolvedValues: true,
      hasInheritedValues: true,
      hasDisplayValue: true,
      hasNoUnrelatedComputedValues: true
    });

    await clickSelectorInFrameContainingSelector(
      '#smart-page-translator-browser-toolbar',
      '#inspect-button'
    );
    assert.deepEqual(await readInspectModeButtons(), {
      basic: true,
      full: false
    });

    await clickSelectorInFrameContainingSelector(
      '#smart-page-translator-browser-toolbar',
      '#inspect-plus-button'
    );
    assert.deepEqual(await readInspectModeButtons(), {
      basic: false,
      full: true
    });

    await clickSelectorInFrameContainingSelector(
      '#smart-page-translator-browser-toolbar',
      '#html-preview-e2e-action-icon'
    );
    await browser.waitUntil(async () => {
      const state = await browser.executeWorkbench((vscode, command) => (
        vscode.commands.executeCommand(command)
      ), COMMANDS.internal.getBrowserState);
      const clipboard = await readClipboardState({
        includes: 'html-preview-e2e-action',
        startsWith: 'Attached Element Context from Integrated Browser',
        textLimit: 4000
      });
      return state.active?.selectedElement?.id === 'html-preview-e2e-action'
        && clipboard.includes
        && clipboard.startsWith;
    }, {
      timeout: 10000,
      interval: 200,
      timeoutMsg: '选择元素+ 未自动复制完整元素上下文'
    });

    await clickSelectorInFrameContainingSelector(
      '#smart-page-translator-browser-toolbar',
      '#inspect-plus-button'
    );
    assert.deepEqual(await readInspectModeButtons(), {
      basic: false,
      full: false
    });

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
    assert.equal(
      logs.some((entry) => entry.message.includes("Identifier 'notify' has already been declared")),
      false
    );
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

async function selectBrowserElementBySelector(selector, clipboardOptions, selectionOptions) {
  let state;
  await browser.waitUntil(async () => {
    await browser.executeWorkbench(async (vscode, args) => {
      await vscode.commands.executeCommand(args.command, args.selector, args.selectionOptions);
    }, {
      command: COMMANDS.internal.selectBrowserElementBySelector,
      selector,
      selectionOptions
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

async function readInspectModeButtons() {
  await switchToTopFrame();
  const found = await switchToFrameContainingSelector('#smart-page-translator-browser-toolbar');
  assert.equal(found, true);
  try {
    return await browser.execute(() => ({
      basic: document.getElementById('inspect-button')?.classList.contains('active') === true,
      full: document.getElementById('inspect-plus-button')?.classList.contains('active') === true
    }));
  } finally {
    await switchToTopFrame();
  }
}

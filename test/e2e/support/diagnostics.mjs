import fs from 'node:fs';
import path from 'node:path';
import { EXTENSION_ID } from './extension-contract.mjs';

export function artifactsDir() {
  const dir = process.env.WDIO_ARTIFACTS_DIR;
  if (!dir) {
    throw new Error('WDIO_ARTIFACTS_DIR is not set. Run tests through wdio.conf.mjs.');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function artifactPath(...segments) {
  const target = path.join(artifactsDir(), ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

export function appendJsonl(fileName, payload) {
  fs.appendFileSync(
    artifactPath(fileName),
    `${JSON.stringify({ at: new Date().toISOString(), ...safeValue(payload) })}\n`,
    'utf8'
  );
}

export function saveJson(fileName, payload) {
  fs.writeFileSync(artifactPath(fileName), `${JSON.stringify(safeValue(payload), null, 2)}\n`, 'utf8');
}

export function saveText(fileName, value) {
  fs.writeFileSync(artifactPath(fileName), String(value), 'utf8');
}

export function slugify(value) {
  return String(value)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .toLowerCase() || 'snapshot';
}

export async function switchToTopFrame() {
  if (typeof browser.switchFrame === 'function') {
    await browser.switchFrame(null);
    return;
  }

  await browser.switchToFrame(null);
}

export async function readVisibleTextFromFrameContainingSelector(selector) {
  await switchToTopFrame();
  const found = await switchToFrameContainingSelector(selector);
  if (!found) {
    await switchToTopFrame();
    throw new Error(`找不到包含 ${selector} 的 frame`);
  }

  try {
    return await browser.execute(() => String(
      document.body?.innerText || document.body?.textContent || ''
    ).replace(/\s+/g, ' ').trim());
  } finally {
    await switchToTopFrame();
  }
}

export async function dumpExtensionState() {
  return browser.executeWorkbench(async (vscode, extensionId) => {
    const extension = vscode.extensions.getExtension(extensionId);
    const commands = await vscode.commands.getCommands(true);
    const activeEditor = vscode.window.activeTextEditor;
    const smartConfig = vscode.workspace.getConfiguration('smartPageTranslator');

    return {
      extension: extension
        ? {
          id: extension.id,
          isActive: extension.isActive,
          extensionMode: extension.extensionMode,
          extensionPath: extension.extensionPath,
          version: extension.packageJSON?.version
        }
        : undefined,
      commands: commands
        .filter((command) => command.startsWith('smartPageTranslator.'))
        .sort(),
      activeEditor: activeEditor
        ? {
          fileName: activeEditor.document.fileName,
          languageId: activeEditor.document.languageId,
          scheme: activeEditor.document.uri.scheme,
          isDirty: activeEditor.document.isDirty,
          textLength: activeEditor.document.getText().length
        }
        : undefined,
      terminals: vscode.window.terminals.map((terminal) => ({
        name: terminal.name,
        processId: typeof terminal.processId?.then === 'function' ? undefined : terminal.processId
      })),
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [],
      configuration: {
        concurrency: smartConfig.get('concurrency'),
        maxChunk: smartConfig.get('maxChunk'),
        notesLocation: smartConfig.get('notes.notesLocation'),
        notesExtensions: smartConfig.get('notes.notesExtensions'),
        notesDefaultNoteExtension: smartConfig.get('notes.notesDefaultNoteExtension')
      }
    };
  }, EXTENSION_ID);
}

export async function collectUiSnapshot(label) {
  const safeLabel = slugify(label);
  const screenshotFile = `screenshots/${safeLabel}.png`;
  const htmlFile = `html/${safeLabel}.html`;
  const jsonFile = `ui-snapshots/${safeLabel}.json`;
  const reportFile = `ui-reports/${safeLabel}.md`;

  const source = await browser.getPageSource();
  saveText(htmlFile, source);

  try {
    await browser.saveScreenshot(artifactPath(screenshotFile));
  } catch (error) {
    saveJson(`screenshots/${safeLabel}.error.json`, error);
  }

  const visual = await browser.execute(() => {
    const interactiveSelector = [
      'button',
      'input',
      'textarea',
      'select',
      'a',
      '[role="button"]',
      '[role="textbox"]',
      '[tabindex]'
    ].join(',');

    const snapshotSelector = [
      'body',
      'main',
      'section',
      'header',
      'footer',
      'nav',
      'aside',
      'article',
      'h1',
      'h2',
      'h3',
      'h4',
      'p',
      'label',
      'strong',
      '[data-testid]',
      '[aria-label]',
      '[role]',
      'button',
      'input',
      'textarea',
      'select',
      'a',
      '.monaco-list-row',
      '.monaco-icon-label',
      '.action-item',
      '.codicon'
    ].join(',');

    const elements = Array.from(document.querySelectorAll(snapshotSelector))
      .filter(isVisible)
      .slice(0, 400)
      .map((node, index) => describeElement(node, index));

    const interactive = Array.from(document.querySelectorAll(interactiveSelector))
      .filter(isVisible)
      .slice(0, 150)
      .map((node, index) => describeElement(node, index));

    return {
      capturedAt: new Date().toISOString(),
      document: {
        title: document.title,
        url: document.location.href,
        bodyClass: typeof document.body?.className === 'string' ? document.body.className : undefined,
        visibleText: cleanText(document.body?.innerText || document.body?.textContent || '').slice(0, 4000)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      outline: describeTree(document.body, 0, 5),
      elements,
      interactive
    };

    function describeTree(node, depth, maxDepth) {
      if (!(node instanceof Element) || !isVisible(node)) {
        return undefined;
      }

      const children = depth >= maxDepth
        ? []
        : Array.from(node.children)
          .map((child) => describeTree(child, depth + 1, maxDepth))
          .filter(Boolean);

      const signal = describeElement(node);
      const directText = cleanText(Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent || '')
        .join(' '));
      const leafText = children.length === 0 ? cleanText(node.innerText || node.textContent || '') : directText;

      return {
        ...signal,
        text: leafText.slice(0, 220),
        children
      };
    }

    function describeElement(node, index) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const rawText = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value || node.placeholder
        : node.innerText || node.textContent || '';

      return {
        index,
        tag: node.tagName.toLowerCase(),
        id: node.id || undefined,
        testId: node.getAttribute('data-testid') || undefined,
        role: node.getAttribute('role') || undefined,
        ariaLabel: node.getAttribute('aria-label') || undefined,
        title: node.getAttribute('title') || undefined,
        className: typeof node.className === 'string'
          ? node.className.split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
          : undefined,
        text: cleanText(rawText).slice(0, 220),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        style: {
          display: style.display,
          position: style.position,
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          margin: compactBox(style.marginTop, style.marginRight, style.marginBottom, style.marginLeft),
          padding: compactBox(style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft),
          border: style.border,
          borderRadius: style.borderRadius,
          flexDirection: style.flexDirection,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          gap: style.gap,
          overflow: style.overflow,
          whiteSpace: style.whiteSpace
        }
      };
    }

    function isVisible(node) {
      if (!(node instanceof Element)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0;
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function compactBox(top, right, bottom, left) {
      if (top === right && right === bottom && bottom === left) {
        return top;
      }
      return `${top} ${right} ${bottom} ${left}`;
    }
  });

  const snapshot = {
    label,
    artifacts: {
      html: htmlFile,
      screenshot: screenshotFile,
      json: jsonFile,
      report: reportFile
    },
    ...visual
  };

  saveJson(jsonFile, snapshot);
  saveText(reportFile, renderUiReport(snapshot));

  return snapshot;
}

function renderUiReport(snapshot) {
  const lines = [];
  lines.push(`# UI Snapshot: ${snapshot.label}`);
  lines.push('');
  lines.push(`Captured: ${snapshot.capturedAt}`);
  lines.push(`URL: ${snapshot.document.url || '(no url)'}`);
  lines.push(`Title: ${snapshot.document.title || '(no title)'}`);
  lines.push(`Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height} @ ${snapshot.viewport.devicePixelRatio}x`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- HTML: ${snapshot.artifacts.html}`);
  lines.push(`- Screenshot: ${snapshot.artifacts.screenshot}`);
  lines.push(`- JSON: ${snapshot.artifacts.json}`);
  lines.push('');
  lines.push('## Visible Text');
  lines.push('');
  lines.push(snapshot.document.visibleText || '(no visible text)');
  lines.push('');
  lines.push('## Visual Outline');
  lines.push('');
  lines.push('```text');
  lines.push(...renderOutline(snapshot.outline));
  lines.push('```');
  lines.push('');
  lines.push('## Interactive Elements');
  lines.push('');
  if (snapshot.interactive.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| # | Element | Text | Rect | Key Style |');
    lines.push('| - | - | - | - | - |');
    for (const element of snapshot.interactive) {
      lines.push(`| ${element.index ?? ''} | ${escapeMd(elementName(element))} | ${escapeMd(element.text || element.ariaLabel || '')} | ${formatRect(element.rect)} | ${escapeMd(formatStyle(element.style))} |`);
    }
  }
  lines.push('');
  lines.push('## Visible Element Inventory');
  lines.push('');
  lines.push('```text');
  for (const element of snapshot.elements) {
    lines.push(`${String(element.index).padStart(3, ' ')} ${elementName(element)} ${formatRect(element.rect)} text="${truncate(element.text || element.ariaLabel || '', 120)}" ${formatStyle(element.style)}`);
  }
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderOutline(node, depth = 0) {
  if (!node) {
    return ['(empty)'];
  }

  const lines = [
    `${'  '.repeat(depth)}- ${elementName(node)} ${formatRect(node.rect)} ${formatStyle(node.style)}${node.text ? ` text="${truncate(node.text, 160)}"` : ''}`
  ];

  for (const child of node.children || []) {
    lines.push(...renderOutline(child, depth + 1));
  }

  return lines;
}

function elementName(element) {
  const parts = [element.tag];
  if (element.id) {
    parts.push(`#${element.id}`);
  }
  if (element.testId) {
    parts.push(`[testid=${element.testId}]`);
  }
  if (element.role) {
    parts.push(`[role=${element.role}]`);
  }
  if (element.ariaLabel) {
    parts.push(`[aria="${truncate(element.ariaLabel, 60)}"]`);
  }
  if (element.className) {
    parts.push(`.${element.className.replace(/\s+/g, '.')}`);
  }
  return parts.join('');
}

function formatRect(rect) {
  if (!rect) {
    return 'rect=?';
  }
  return `rect=${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatStyle(style) {
  if (!style) {
    return '';
  }

  const entries = [
    ['display', style.display],
    ['pos', style.position],
    ['color', style.color],
    ['bg', style.backgroundColor],
    ['font', `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`],
    ['padding', style.padding],
    ['margin', style.margin],
    ['border', style.border],
    ['radius', style.borderRadius],
    ['flex', style.flexDirection],
    ['align', style.alignItems],
    ['justify', style.justifyContent],
    ['gap', style.gap],
    ['overflow', style.overflow]
  ].filter(([, value]) => value && value !== 'normal' && value !== 'none 0px rgb(0, 0, 0)' && value !== '0px' && value !== 'auto');

  return entries.map(([key, value]) => `${key}=${value}`).join(' ');
}

function escapeMd(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

export async function captureDiagnostics(label, error) {
  const safeLabel = slugify(label);
  const prefix = `snapshots/${safeLabel}`;

  try {
    await collectUiSnapshot(label);
  } catch (snapshotError) {
    saveJson(`${prefix}.ui-snapshot-error.json`, snapshotError);
  }

  try {
    const logs = await browser.getLogs('browser');
    saveJson(`${prefix}.browser-logs.json`, logs);
  } catch (logsError) {
    saveJson(`${prefix}.browser-logs-error.json`, logsError);
  }

  try {
    saveJson(`${prefix}.extension-state.json`, await dumpExtensionState());
  } catch (stateError) {
    saveJson(`${prefix}.extension-state-error.json`, stateError);
  }

  if (error) {
    saveJson(`${prefix}.test-error.json`, normalizeError(error));
  }
}

async function switchToFrameContainingSelector(selector, depth = 0) {
  if (await $(selector).isExisting()) {
    return true;
  }

  if (depth >= 4) {
    return false;
  }

  const frames = await $$('iframe');
  for (const frame of frames) {
    await browser.switchToFrame(frame);
    if (await switchToFrameContainingSelector(selector, depth + 1)) {
      return true;
    }
    await browser.switchToParentFrame();
  }

  return false;
}

export function safeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => safeValue(item, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sessionId') {
      output[key] = item;
      continue;
    }

    if (key.startsWith('_') || key === 'parent' || key === 'options') {
      continue;
    }

    output[key] = safeValue(item, seen);
  }

  return output;
}

function normalizeError(error) {
  return {
    name: error?.name,
    message: error?.message || String(error),
    stack: error?.stack
  };
}

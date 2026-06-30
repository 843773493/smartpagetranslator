import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendJsonl,
  captureDiagnostics,
  saveJson,
  safeValue,
  slugify
} from './test/e2e/support/diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runId = process.env.WDIO_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const artifactsRoot = process.env.WDIO_ARTIFACTS_DIR || path.join(__dirname, 'e2e', 'artifacts', runId);
const storagePath = path.join(artifactsRoot, 'vscode-storage');
const fixtureWorkspacePath = path.join(__dirname, 'test-fixtures', 'workspace');
const workspacePath = path.join(artifactsRoot, 'workspace');
const notesPath = path.join(workspacePath, 'notes');
const vscodeBinary = process.env.VSCODE_BINARY || process.env.VSCODE_PATH;

process.env.WDIO_RUN_ID = runId;
process.env.WDIO_ARTIFACTS_DIR = artifactsRoot;
process.env.WDIO_WORKSPACE_PATH = workspacePath;
process.env.WDIO_NOTES_PATH = notesPath;

export const paths = {
  rootDir: __dirname,
  artifactsRoot,
  storagePath,
  fixtureWorkspacePath,
  workspacePath,
  notesPath
};

let commandSequence = 0;

export const config = {
  runner: 'local',
  rootDir: __dirname,
  specs: ['./test/e2e/specs/**/*.e2e.mjs'],
  maxInstances: 1,
  logLevel: process.env.WDIO_LOG_LEVEL || 'info',
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  xvfbAutoInstall: true,
  outputDir: path.join(artifactsRoot, 'wdio-output'),
  framework: 'mocha',
  reporters: [
    ['spec', { addConsoleLogs: true }],
    ['json', {
      outputDir: path.join(artifactsRoot, 'json-reporter'),
      outputFileFormat: ({ cid }) => `wdio-${cid}.json`
    }]
  ],
  capabilities: [{
    browserName: 'vscode',
    browserVersion: process.env.VSCODE_VERSION || 'stable',
    'wdio:enforceWebDriverClassic': true,
    'wdio:chromedriverOptions': {
      verbose: true,
      logPath: path.join(artifactsRoot, 'wdio-output', 'chromedriver-verbose.log')
    },
    'wdio:vscodeOptions': {
      ...(vscodeBinary ? { binary: vscodeBinary } : {}),
      extensionPath: __dirname,
      workspacePath,
      storagePath,
      verboseLogging: true,
      userSettings: {
        'telemetry.telemetryLevel': 'off',
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'workbench.commandPalette.experimental.suggestCommands': false,
        'window.commandCenter': false,
        'update.mode': 'none',
        'smartPageTranslator.notes.notesLocation': notesPath,
        'smartPageTranslator.notes.notesExtensions': 'md,txt',
        'smartPageTranslator.notes.notesDefaultNoteExtension': 'md'
      },
      vscodeArgs: {
        'disable-workspace-trust': true,
        'disable-telemetry': true,
        'disable-updates': true,
        'disable-dev-shm-usage': true,
        'disable-gpu': true,
        'skip-welcome': true,
        'no-sandbox': process.platform === 'linux'
      },
      vscodeProxyOptions: {
        enable: true,
        connectionTimeout: 120000,
        commandTimeout: 60000
      }
    }
  }],
  services: [
    ['vscode', {
      cachePath: path.join(__dirname, '.wdio-vscode-cache')
    }]
  ],
  mochaOpts: {
    ui: 'bdd',
    timeout: 180000
  },
  onPrepare() {
    fs.mkdirSync(artifactsRoot, { recursive: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.cpSync(fixtureWorkspacePath, workspacePath, { recursive: true });
    saveJson('run-metadata.json', {
      runId,
      startedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      rootDir: __dirname,
      fixtureWorkspacePath,
      workspacePath,
      notesPath,
      storagePath,
      vscodeBinary: vscodeBinary || null,
      vscodeVersion: process.env.VSCODE_VERSION || 'stable'
    });
  },
  beforeSession(config, capabilities) {
    appendJsonl('sessions.jsonl', {
      event: 'beforeSession',
      capabilities: safeValue(capabilities)
    });
  },
  beforeCommand(commandName, args) {
    appendJsonl('commands.jsonl', {
      phase: 'before',
      seq: ++commandSequence,
      commandName,
      args: safeValue(args)
    });
  },
  afterCommand(commandName, args, result, error) {
    appendJsonl('commands.jsonl', {
      phase: 'after',
      seq: commandSequence,
      commandName,
      result: safeValue(result),
      error: error ? safeValue(error) : undefined
    });
  },
  async afterTest(test, _context, result) {
    const label = `${test.parent} ${test.title}`;
    appendJsonl('tests.jsonl', {
      title: test.title,
      parent: test.parent,
      passed: result.passed,
      duration: result.duration,
      retries: result.retries,
      error: result.error ? safeValue(result.error) : undefined
    });

    if (!result.passed || process.env.WDIO_CAPTURE_SUCCESS === '1') {
      await captureDiagnostics(label, result.error);
    }
  },
  onComplete(exitCode, config, capabilities, results) {
    saveJson('run-complete.json', {
      exitCode,
      completedAt: new Date().toISOString(),
      results: safeValue(results),
      storageFiles: listFiles(storagePath, 500)
    });
  }
};

function listFiles(root, limit) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const output = [];
  const stack = [root];

  while (stack.length > 0 && output.length < limit) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const stat = fs.statSync(fullPath);
      output.push({
        path: path.relative(root, fullPath),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    }
  }

  return output.sort((a, b) => a.path.localeCompare(b.path));
}

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workspacePath = path.join(rootDir, 'test-fixtures', 'workspace');
const tmpDir = path.join(rootDir, '.tmp', 'dev-host');
const userDataDir = path.join(tmpDir, 'user-data');
const extensionsDir = path.join(tmpDir, 'extensions');
const binary = process.env.VSCODE_BINARY || findOnPath('code-insiders') || findOnPath('code');

if (!binary) {
  console.error('Cannot find VS Code. Set VSCODE_BINARY=/path/to/code or install code/code-insiders on PATH.');
  process.exit(1);
}

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(extensionsDir, { recursive: true });

const args = [
  '--new-window',
  `--extensionDevelopmentPath=${rootDir}`,
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${extensionsDir}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  workspacePath
];

console.log(`Launching VS Code dev host:\n${binary} ${args.join(' ')}`);

const child = spawn(binary, args, {
  cwd: rootDir,
  stdio: 'inherit',
  detached: false
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

function findOnPath(name) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

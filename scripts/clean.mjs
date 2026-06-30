import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] || 'build';
const targetGroups = {
  build: ['out', '.tmp'],
  artifacts: ['e2e/artifacts'],
  cache: ['.wdio-vscode-cache', '.vscode-test'],
  all: ['out', '.tmp', 'e2e/artifacts', '.wdio-vscode-cache', '.vscode-test']
};

const targets = targetGroups[mode];
if (!targets) {
  console.error(`Unknown clean mode: ${mode}`);
  console.error(`Valid modes: ${Object.keys(targetGroups).join(', ')}`);
  process.exit(1);
}

for (const target of targets) {
  const fullPath = path.join(rootDir, target);
  fs.rmSync(fullPath, { recursive: true, force: true });
  console.log(`Removed ${fullPath}`);
}

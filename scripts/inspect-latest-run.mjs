import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactsRoot = path.join(rootDir, 'e2e', 'artifacts');

if (!fs.existsSync(artifactsRoot)) {
  console.log(`No artifacts directory found: ${artifactsRoot}`);
  process.exit(0);
}

const runs = fs.readdirSync(artifactsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const fullPath = path.join(artifactsRoot, entry.name);
    return { name: entry.name, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (runs.length === 0) {
  console.log(`No E2E runs found in ${artifactsRoot}`);
  process.exit(0);
}

const latest = runs[0];
console.log(`Latest E2E run: ${latest.path}`);

printJson('Metadata', path.join(latest.path, 'run-metadata.json'));
printJson('Completion', path.join(latest.path, 'run-complete.json'));

const commands = path.join(latest.path, 'commands.jsonl');
if (fs.existsSync(commands)) {
  const lines = fs.readFileSync(commands, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  console.log(`Commands: ${lines.length} entries (${commands})`);
  console.log(`Last commands:\n${lines.slice(-8).join('\n')}`);
}

const snapshots = findFiles(latest.path, (file) => file.startsWith('snapshots/') && /\.(png|html|json)$/.test(file));
if (snapshots.length > 0) {
  console.log('\nSnapshots:');
  for (const file of snapshots.slice(0, 20)) {
    console.log(`- ${path.join(latest.path, file)}`);
  }
}

const uiReports = findFiles(latest.path, (file) => file.startsWith('ui-reports/') && file.endsWith('.md'));
if (uiReports.length > 0) {
  console.log('\nUI reports for text-only review:');
  for (const file of uiReports.slice(0, 20)) {
    console.log(`- ${path.join(latest.path, file)}`);
  }
}

const uiSnapshots = findFiles(latest.path, (file) => file.startsWith('ui-snapshots/') && file.endsWith('.json'));
if (uiSnapshots.length > 0) {
  console.log('\nUI snapshot JSON:');
  for (const file of uiSnapshots.slice(0, 20)) {
    console.log(`- ${path.join(latest.path, file)}`);
  }
}

const htmlSnapshots = findFiles(latest.path, (file) => file.startsWith('html/') && file.endsWith('.html'));
if (htmlSnapshots.length > 0) {
  console.log('\nHTML snapshots:');
  for (const file of htmlSnapshots.slice(0, 20)) {
    console.log(`- ${path.join(latest.path, file)}`);
  }
}

const screenshots = findFiles(latest.path, (file) => file.startsWith('screenshots/') && /\.(png|jpg|jpeg)$/.test(file));
if (screenshots.length > 0) {
  console.log('\nScreenshots:');
  for (const file of screenshots.slice(0, 20)) {
    console.log(`- ${path.join(latest.path, file)}`);
  }
}

const traces = findFiles(latest.path, (file) => file.endsWith('.zip') || /wdio-trace-.+\.json$/.test(file));
if (traces.length > 0) {
  console.log('\nDevTools traces:');
  for (const file of traces) {
    const fullPath = path.join(latest.path, file);
    console.log(`- ${fullPath}`);
    if (file.endsWith('.zip')) {
      console.log(`  open: npx playwright show-trace ${fullPath}`);
    }
  }
}

function printJson(label, file) {
  if (!fs.existsSync(file)) {
    return;
  }

  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n${label}:`);
  console.log(JSON.stringify(value, null, 2).slice(0, 5000));
}

function findFiles(root, predicate) {
  const output = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (predicate(relative)) {
        output.push(relative);
      }
    }
  }

  return output.sort();
}

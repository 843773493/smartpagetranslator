const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outDir = path.join(root, 'build');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outName = `${pkg.name}-${pkg.version}.vsix`;

console.log(`Packaging ${outName} into ${outDir}`);
try {
  execSync(`npx vsce package -o "${path.join(outDir, outName)}"`, { stdio: 'inherit' });
  console.log('Package created successfully.');
} catch (err) {
  console.error('Packaging failed.');
  process.exit(err.status || 1);
}
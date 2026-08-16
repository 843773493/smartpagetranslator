const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(root, 'build', vsixName);

if (!fs.existsSync(vsixPath)) {
  console.error(`未找到已打包的 VSIX: ${vsixPath}`);
  process.exit(1);
}

console.log(`Publishing ${vsixName} to Marketplace...`);
try {
  execSync(`npx --no-install @vscode/vsce publish -i "${vsixPath}"`, { stdio: 'inherit' });
  console.log('Publish completed successfully.');
} catch (err) {
  console.error('Publish failed.');
  process.exit(err.status || 1);
}

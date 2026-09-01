const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outDir = path.join(root, 'build');
const runtimeDependencyNames = [
  '@babel/parser',
  '@babel/traverse',
  'bing-translate-api',
  'fflate',
  'glob',
  'rimraf',
  'ws'
];
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outName = `${pkg.name}-${pkg.version}.vsix`;

console.log(`Packaging ${outName} into ${outDir}`);
try {
  const packagedFiles = execSync(
    'npx --no-install @vscode/vsce ls --dependencies --no-yarn',
    { cwd: root, encoding: 'utf8' }
  );
  const missingDependencies = runtimeDependencyNames.filter(name => (
    !packagedFiles.split(/\r?\n/).includes(`node_modules/${name}/package.json`)
  ));
  if (missingDependencies.length > 0) {
    throw new Error(`VSIX 缺少运行时依赖：${missingDependencies.join(', ')}`);
  }
  execSync(`npx --no-install @vscode/vsce package --dependencies --no-yarn -o "${path.join(outDir, outName)}"`, { stdio: 'inherit' });
  console.log('Package created successfully.');
} catch (err) {
  console.error('Packaging failed.');
  process.exit(err.status || 1);
}

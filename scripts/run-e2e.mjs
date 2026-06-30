import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] || 'default';

const configByMode = {
  default: 'wdio.conf.mjs',
  trace: 'wdio.trace.conf.mjs',
  debug: 'wdio.debug.conf.mjs'
};

const config = configByMode[mode];
if (!config) {
  console.error(`Unknown E2E mode: ${mode}`);
  console.error(`Valid modes: ${Object.keys(configByMode).join(', ')}`);
  process.exit(1);
}

await run('npm', ['run', 'compile']);
await run(process.execPath, [
  path.join(rootDir, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js'),
  'run',
  path.join(rootDir, config)
], {
  env: wdioEnv()
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      env: options.env || process.env,
      shell: process.platform === 'win32'
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}`));
    });
  });
}

function wdioEnv() {
  const env = { ...process.env };

  if (env.WDIO_KEEP_PROXY === '1') {
    return env;
  }

  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'npm_config_proxy',
    'npm_config_http_proxy',
    'npm_config_https_proxy'
  ]) {
    delete env[key];
  }

  env.NO_PROXY = env.NO_PROXY || 'localhost,127.0.0.1,::1';
  env.no_proxy = env.no_proxy || env.NO_PROXY;
  env.NODE_OPTIONS = [
    env.NODE_OPTIONS,
    `--require=${path.join(rootDir, 'scripts', 'node-network-fallback.cjs')}`
  ].filter(Boolean).join(' ');
  return env;
}

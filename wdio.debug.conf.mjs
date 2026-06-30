import fs from 'node:fs';
import path from 'node:path';
import { config as baseConfig, paths } from './wdio.conf.mjs';
import {
  createScreencastOptions,
  withChromedriverLogPath
} from './test/e2e/support/wdio-config.mjs';

const devtoolsPort = Number(process.env.WDIO_DEVTOOLS_PORT || 42017);
const debugOutputDir = path.join(paths.artifactsRoot, 'wdio-debug-output');
fs.mkdirSync(debugOutputDir, { recursive: true });

export const config = {
  ...baseConfig,
  outputDir: debugOutputDir,
  capabilities: withChromedriverLogPath(baseConfig.capabilities, debugOutputDir),
  services: [
    ...baseConfig.services,
    ['devtools', {
      mode: 'live',
      hostname: '127.0.0.1',
      port: devtoolsPort,
      screencast: createScreencastOptions()
    }]
  ],
  before(...args) {
    console.log(`WDIO DevTools UI: http://127.0.0.1:${devtoolsPort}`);
    return baseConfig.before?.(...args);
  }
};

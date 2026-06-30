import fs from 'node:fs';
import path from 'node:path';
import { config as baseConfig, paths } from './wdio.conf.mjs';
import {
  createOptionalScreencastOptions,
  withChromedriverLogPath
} from './test/e2e/support/wdio-config.mjs';

const traceOutputDir = path.join(paths.artifactsRoot, 'wdio-trace-output');
fs.mkdirSync(traceOutputDir, { recursive: true });

export const config = {
  ...baseConfig,
  outputDir: traceOutputDir,
  capabilities: withChromedriverLogPath(baseConfig.capabilities, traceOutputDir),
  services: [
    ...baseConfig.services,
    ['devtools', {
      mode: 'trace',
      screencast: createOptionalScreencastOptions()
    }]
  ]
};

import path from 'node:path';

const screencastDefaults = {
  captureFormat: 'jpeg',
  quality: 70,
  maxWidth: 1400,
  maxHeight: 900
};

export function withChromedriverLogPath(capabilities, outputDir) {
  return capabilities.map((capability) => ({
    ...capability,
    'wdio:chromedriverOptions': {
      ...capability['wdio:chromedriverOptions'],
      logPath: path.join(outputDir, 'chromedriver-verbose.log')
    }
  }));
}

export function createScreencastOptions(enabled = process.env.WDIO_SCREENCAST === '1') {
  return {
    enabled,
    ...screencastDefaults
  };
}

export function createOptionalScreencastOptions() {
  return process.env.WDIO_SCREENCAST === '1'
    ? createScreencastOptions(true)
    : undefined;
}

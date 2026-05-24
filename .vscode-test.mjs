import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	version: 'stable',
	workspaceFolder: '.',
	files: './out/src/test/suite/**/*.test.js',
	mocha: {
		ui: 'tdd',
		color: true
	}
});
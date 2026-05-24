import * as path from 'path';
import { globSync } from 'glob';
import 'mocha';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Mocha = require('mocha');

export async function run(): Promise<void> {
	const mocha = new Mocha({
		ui: 'tdd',
		color: true
	});

	const testsRoot = path.resolve(__dirname);
	const files = globSync('**/*.test.js', { cwd: testsRoot }).sort();

	if (files.length === 0) {
		throw new Error(`No compiled test files found in ${testsRoot}`);
	}

	files.forEach((file: string) => mocha.addFile(path.resolve(testsRoot, file)));

	await new Promise<void>((resolve, reject) => {
		mocha.run((failures: number) => {
			if (failures > 0) {
				reject(new Error(`${failures} tests failed.`));
				return;
			}

			resolve();
		});
	});
}
/**
 * Runs the compiled test suite.
 *
 * A small script rather than a shell glob, because `npm test` runs under cmd.exe
 * on Windows (which does not expand globs) and Node's own directory discovery
 * differs between versions. This works identically everywhere.
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, 'dist', 'test', 'tests');

if (!existsSync(testDir)) {
  console.error(`No compiled tests at ${testDir}. Run "tsc -p tsconfig.test.json" first.`);
  process.exit(1);
}

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(testDir, f))
  .sort();

if (files.length === 0) {
  console.error('No compiled test files were found.');
  process.exit(1);
}

console.log(`Running ${files.length} test files\n`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);

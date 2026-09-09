import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const dir of ['dist', 'release']) {
  await rm(join(root, dir), { recursive: true, force: true });
}
console.log('cleaned dist and release');

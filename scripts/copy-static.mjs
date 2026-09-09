/**
 * Copies the renderer's static files next to the compiled JavaScript.
 * `tsc` emits to dist/renderer/renderer/*.js (it keeps the src layout), so the
 * HTML lives one level up and points at ./renderer/main.js.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'renderer');

await mkdir(out, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await cp(join(root, 'src', 'renderer', file), join(out, file));
}
console.log('renderer static files copied to dist/renderer');

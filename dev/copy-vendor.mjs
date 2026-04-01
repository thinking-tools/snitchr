import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'static', 'vendor');
const nm = join(root, 'node_modules');

await mkdir(dest, { recursive: true });
await Promise.all([
  copyFile(join(nm, 'oat-glassed', 'oat-glassed.min.css'), join(dest, 'oat-glassed.min.css')),
  copyFile(join(nm, 'oat-glassed', 'oat-glassed.min.js'), join(dest, 'oat-glassed.min.js')),
  copyFile(join(nm, 'three', 'build', 'three.module.js'), join(dest, 'three.module.js')),
  copyFile(join(nm, 'three', 'build', 'three.core.js'), join(dest, 'three.core.js')),
  copyFile(join(nm, 'world-atlas', 'land-110m.json'), join(dest, 'land-110m.json')),
]);

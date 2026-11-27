import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const source = new URL('../node_modules/pyodide/', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
if (version !== '0.27.7') throw new Error('Update the sandbox runtime path before changing Pyodide');
const target = new URL(`../public/python-runtime/${version}/`, import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  const bytes = await readFile(new URL(name, source));
  await writeFile(new URL(name, target), bytes);
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.byteLength < bytes.byteLength) {
    await writeFile(new URL(`${name}.gz`, target), compressed);
  }
}
await copyFile(new URL('PYODIDE-LICENSE.txt', import.meta.url), new URL('LICENSE.txt', target));
console.log(`Prepared local Python runtime: ${fileURLToPath(target)}`);

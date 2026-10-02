import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function syncAssets() {
  const source = await readFile(new URL('../src/client/tracking.worker.ts', import.meta.url), 'utf8');
  const output = stripTypeScriptTypes(source).replace(/export \{\};?\s*$/, '');
  await writeFile(new URL('../public/tracking-worker.js', import.meta.url), output);
  const destination = new URL('../public/mediapipe/', import.meta.url);
  await mkdir(destination, { recursive: true });
  await copyFile(new URL('../node_modules/@mediapipe/tasks-vision/vision_bundle.js', import.meta.url), new URL('vision_bundle.js', destination));
  await cp(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url), new URL('wasm/', destination), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await syncAssets();

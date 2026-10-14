import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

export async function syncAssets() {
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: { write: false, lib: { entry: fileURLToPath(new URL('../src/client/tracking.worker.ts', import.meta.url)), name: 'FoxTracking', formats: ['iife'] } },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const output = bundles.flatMap(bundle => bundle.output).find(chunk => chunk.type === 'chunk');
  if (!output) throw new Error('Tracking worker bundle unavailable');
  await writeFile(new URL('../public/tracking-worker.js', import.meta.url), output.code);
  const destination = new URL('../public/mediapipe/', import.meta.url);
  await mkdir(destination, { recursive: true });
  await copyFile(new URL('../node_modules/@mediapipe/tasks-vision/vision_bundle.js', import.meta.url), new URL('vision_bundle.js', destination));
  await cp(new URL('../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url), new URL('wasm/', destination), { recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await syncAssets();

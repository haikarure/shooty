import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'dist');
const files = [
  'index.html', 'manifest.webmanifest',
  'web/style.css', 'web/game-core.js', 'web/audio.js', 'web/app.js',
  'web/duel-client.js', 'web/vision-client.js', 'web/wallet-client.js',
  'web/icons/icon.svg', 'web/icons/icon-192.png', 'web/icons/icon-512.png',
  'web/audio/pistol-1911.wav', 'web/audio/pistol-reload-start.wav',
  'web/audio/pistol-reload-complete.wav', 'web/audio/CREDITS.md',
];
const config = {};
if (process.env.SHOOTY_BACKEND_URL) {
  const url = new URL(process.env.SHOOTY_BACKEND_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SHOOTY_BACKEND_URL must be a plain HTTPS origin');
  }
  config.backendUrl = url.origin;
}
await rm(output, { recursive: true, force: true });
for (const file of files) {
  const destination = resolve(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, file), destination);
}
await writeFile(resolve(output, 'web/runtime-config.js'), `window.SHOOTY_CONFIG = Object.freeze(${JSON.stringify(config)});\n`);
console.log(`Built ${files.length + 1} public files; backend: ${config.backendUrl || 'same origin'}`);

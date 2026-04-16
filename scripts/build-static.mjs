/**
 * Production build: copy root index.html + public/ into dist/ without bundling.
 * (Vite rollup would incorrectly process auth-gate.js and the main app chunk.)
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (existsSync(dist)) rmSync(dist, { recursive: true });
mkdirSync(dist, { recursive: true });

cpSync(join(root, 'index.html'), join(dist, 'index.html'));
cpSync(join(root, 'public'), dist, { recursive: true });

console.log('dist/ ready (static copy from index.html + public/)');

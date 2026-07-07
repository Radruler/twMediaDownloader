/**
 * build.mjs — assembles a loadable MV3 extension in dist/.
 *
 *   node build.mjs           one-shot build
 *   node build.mjs --watch   rebuild bundles on change (static copy runs once)
 *
 * What it does:
 *   1. copies src/ (the existing extension, untouched) into dist/,
 *      minus src/deprecated/;
 *   2. bundles the two new capture entries with esbuild:
 *        extension/content/page-interceptor.js -> dist/js/page-interceptor.js
 *        extension/content/index.js            -> dist/js/capture.js
 *   3. writes dist/manifest.json = src/manifest.json + the two content-script
 *      entries (page-interceptor runs in world:"MAIN").
 *
 * src/manifest.json itself is NOT modified — it stays loadable exactly as
 * before; dist/ is the artifact to load unpacked (chrome://extensions).
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

// The only manifest change this project makes for the capture layer (plan 02):
// two content scripts, both document_start, interceptor in the MAIN world.
const CAPTURE_CONTENT_SCRIPTS = [
  {
    matches: ['*://x.com/*', '*://mobile.x.com/*'],
    js: ['js/page-interceptor.js'],
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: false,
  },
  {
    matches: ['*://x.com/*', '*://mobile.x.com/*'],
    js: ['js/capture.js'],
    run_at: 'document_start',
    all_frames: false,
  },
];

async function copyStatic() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(srcDir, distDir, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}deprecated`),
  });
  const manifest = JSON.parse(await readFile(path.join(srcDir, 'manifest.json'), 'utf8'));
  manifest.content_scripts = [...(manifest.content_scripts ?? []), ...CAPTURE_CONTENT_SCRIPTS];
  await writeFile(path.join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const bundleOptions = {
  entryPoints: [
    { in: path.join(root, 'extension/content/page-interceptor.js'), out: 'page-interceptor' },
    { in: path.join(root, 'extension/content/index.js'), out: 'capture' },
  ],
  outdir: path.join(distDir, 'js'),
  bundle: true,
  format: 'iife',
  target: ['chrome111', 'firefox128'],
  sourcemap: false,
  logLevel: 'info',
};

await copyStatic();
if (watch) {
  const context = await esbuild.context(bundleOptions);
  await context.watch();
  console.log('watching extension/ and packages/core/ …');
} else {
  await esbuild.build(bundleOptions);
  console.log(`built ${path.relative(root, distDir)}/ — load it unpacked via chrome://extensions`);
}

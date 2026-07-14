/**
 * Regenerates test/fixtures/graphql/expected/<fixture>.json from the current
 * normalizer output. Run DELIBERATELY (`npm run update-expected`) after an
 * intentional normalizer change, then REVIEW THE DIFF — these files are the
 * contract the tests lock down; regenerating them blindly defeats the tests.
 *
 * Uses a fixed captured_at_ms (see FIXED_CAPTURED_AT in the test file) so
 * output is deterministic.
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const FIXED_CAPTURED_AT = 1751900000000;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturesDir = path.join(root, 'test/fixtures/graphql');
const expectedDir = path.join(fixturesDir, 'expected');
const bundledCore = path.join(tmpdir(), `twmd-core-${process.pid}.mjs`);

await esbuild.build({
  entryPoints: [path.join(root, 'packages/core/src/index.ts')],
  outfile: bundledCore,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'silent',
});
const { normalizePayload } = await import(`file://${bundledCore}`);

await mkdir(expectedDir, { recursive: true });
const files = (await readdir(fixturesDir)).filter((f) => f.endsWith('.json'));
for (const file of files) {
  const fixture = JSON.parse(await readFile(path.join(fixturesDir, file), 'utf8'));
  const op = fixture.__fixture?.op;
  if (!op) {
    console.warn(`skip ${file}: no __fixture.op marker`);
    continue;
  }
  const result = normalizePayload(fixture, op, FIXED_CAPTURED_AT);
  const outPath = path.join(expectedDir, file);
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `${file}: ${result.tweets.length} tweet(s), ${result.tombstones.length} tombstone(s) -> expected/${file}`,
  );
}

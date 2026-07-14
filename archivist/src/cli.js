import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import minimist from 'minimist';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createIngest } from './ingest.js';
import { ingestClientDir } from './snapshot.js';
import { createArchivistServer } from './server.js';

function usage() {
  console.log(`Archivist commands

Usage:
  node archivist/dist/main.mjs ingest-client <client-dir>
  node archivist/dist/main.mjs stats
  node archivist/dist/main.mjs verify
  node archivist/dist/main.mjs rebuild-fts
  node archivist/dist/main.mjs rebuild-threads
  node archivist/dist/main.mjs rebuild-thumbs --clear
  node archivist/dist/main.mjs serve

Config: $ARCHIVIST_DIR/config.json, with ARCHIVIST_* env overrides.`);
}

function openConfigured(dir) {
  const loaded = loadConfig(dir);
  const library = openDb(loaded.config.db_path);
  return { ...loaded, library };
}

export async function runCli(argv = process.argv.slice(2), { dir = undefined } = {}) {
  const args = minimist(argv, { boolean: ['help', 'clear'], alias: { h: 'help' } });
  const [cmd, target] = args._;
  if (!cmd || args.help || cmd === 'help') {
    usage();
    return 0;
  }
  const { config, library } = openConfigured(dir);
  try {
    if (cmd === 'stats') {
      console.log(JSON.stringify(library.stats(), null, 2));
      return 0;
    }
    if (cmd === 'ingest-client') {
      if (!target) throw new Error('ingest-client requires <client-dir>');
      const ingest = createIngest(library, { archiveRoot: config.archive_root, log: console.warn });
      const result = await ingestClientDir(ingest, path.resolve(target), { log: console.warn });
      console.log(JSON.stringify(result, null, 2));
      return result.errors === 0 ? 0 : 1;
    }
    if (cmd === 'verify') {
      const rows = library.raw.prepare('SELECT * FROM files ORDER BY relpath').all();
      const problems = [];
      for (const row of rows) {
        const fullPath = path.join(config.archive_root, row.relpath);
        if (!existsSync(fullPath)) {
          problems.push({ sha256: row.sha256, relpath: row.relpath, problem: 'missing' });
          continue;
        }
        const bytes = readFileSync(fullPath);
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (sha !== row.sha256 || bytes.length !== row.bytes) {
          problems.push({ sha256: row.sha256, relpath: row.relpath, problem: 'mismatch', actual_sha256: sha });
        } else {
          library.raw.prepare('UPDATE files SET verified_at = ? WHERE sha256 = ?').run(Date.now(), row.sha256);
        }
      }
      console.log(JSON.stringify({ checked: rows.length, problems }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }
    if (cmd === 'rebuild-fts') {
      const ingest = createIngest(library, { archiveRoot: config.archive_root });
      console.log(JSON.stringify({ rebuilt: ingest.rebuildFts() }, null, 2));
      return 0;
    }
    if (cmd === 'rebuild-threads') {
      const ingest = createIngest(library, { archiveRoot: config.archive_root });
      console.log(JSON.stringify({ rebuilt: ingest.rebuildThreads() }, null, 2));
      return 0;
    }
    if (cmd === 'rebuild-thumbs') {
      if (args.clear) rmSync(config.thumbs_dir, { recursive: true, force: true });
      await mkdir(config.thumbs_dir, { recursive: true });
      console.log(JSON.stringify({ ok: true, cleared: !!args.clear }, null, 2));
      return 0;
    }
    if (cmd === 'serve') {
      const server = createArchivistServer({ library, config, host: config.bind_host, port: config.port, log: console.warn });
      await server.ready;
      console.log(`Archivist listening on http://${config.bind_host}:${server.port}`);
      await new Promise(() => {});
      return 0;
    }
    throw new Error(`unknown command: ${cmd}`);
  } finally {
    library.close();
  }
}

/**
 * main.js — companion-app entry (plan 06 M1/M2). Plain Node daemon with a
 * log console; the Electron shell + library UI are M3 (deferred).
 *
 * Run through the devcontainer:
 *   docker compose -f .devcontainer/docker-compose.yml exec app npm run app
 * Or directly after a build: node app/dist/main.mjs
 * Config dir: $TWMD_APP_DIR or ~/.twmd-app (config.json, library.sqlite3,
 * archive/).
 */

import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createAppServer } from './server.js';
import { createDownloader } from './downloader.js';
import { createDiskWriter } from './disk-writer.js';
import { runCli } from './cli.js';

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function createLogger(level = 'info') {
  const order = { quiet: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = order[level] ?? order.info;
  return function log(...args) {
    if (threshold < order.info) return;
    console.log(`[${timestamp()}]`, ...args);
  };
}

export async function startApp({
  dir = /** @type {any} */ (undefined),
  fetchImpl = globalThis.fetch,
  gapMs = /** @type {any} */ (undefined),
  retryBaseMs = /** @type {any} */ (undefined),
  registerSignals = true,
  exitOnShutdown = true,
} = {}) {
  const { config, firstRun, file } = loadConfig(dir);
  const host = config.bind_host || '127.0.0.1';
  const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const log = createLogger(config.log_level);

  if (firstRun) {
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log('  twMediaDownloader companion app — FIRST RUN');
    console.log('');
    console.log(`  Pairing token:  ${config.token}`);
    console.log('');
    console.log('  Paste it into the extension (DevTools console on x.com,');
    console.log("  extension context):  localStorage.twmd_app_token = '<token>'");
    console.log(`  Config: ${file}`);
    console.log('════════════════════════════════════════════════════════════');
    console.log('');
  }

  const db = openDb(config.db_path);
  log(`library: ${config.db_path}`, db.stats());

  let server;
  const downloader = createDownloader({
    db,
    writer: createDiskWriter({ db, archiveRoot: config.archive_root }),
    getTemplate: () => server.latestTemplate(),
    log,
    fetchImpl,
    ...(gapMs ? { gapMs } : {}),
    ...(retryBaseMs ? { retryBaseMs } : {}),
    onStatusChange: (patch) => {
      Object.assign(server.status, patch);
      server.sendStatus();
    },
  });

  server = createAppServer({
    port: config.port,
    host,
    token: config.token,
    db,
    log,
    onArchive: (request) => downloader.enqueue(request),
    onBulk: (runId, phase, label) => downloader.setRun(runId, phase, label),
  });

  await server.ready;
  log(`listening on ws://${publicHost}:${server.port} — waiting for the extension`);
  log(`archive root: ${config.archive_root}`);

  const queued = db.queuedArchiveJobs();
  if (queued.length > 0) {
    log(`resuming ${queued.length} queued archive job(s) from SQLite`);
    for (const job of queued) downloader.enqueue({ ...job, reason: 'restart-resume' });
  }

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    log('shutting down…');
    await downloader.shutdown();
    await server.close();
    db.close();
    if (exitOnShutdown) process.exit(0);
  }
  if (registerSignals) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  return { config, db, server, downloader, shutdown };
}

const entryPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
const COMMANDS = new Set(['status', 'requeue', 'archive', 'purge', 'verify', '--help', '-h', 'help']);

if (entryPath) {
  if (COMMANDS.has(process.argv[2])) {
    const code = await runCli(process.argv.slice(2)).catch((error) => {
      console.error(String(error && error.message ? error.message : error));
      return 1;
    });
    process.exit(code);
  } else {
    await startApp();
  }
}

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

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createAppServer } from './server.js';
import { createDownloader } from './downloader.js';
import { createDiskWriter } from './disk-writer.js';

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(...args) {
  console.log(`[${timestamp()}]`, ...args);
}

const { config, firstRun, file } = loadConfig();
const host = process.env.TWMD_APP_HOST || '127.0.0.1';
const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host;

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

const downloader = createDownloader({
  db,
  writer: createDiskWriter({ db, archiveRoot: config.archive_root }),
  getTemplate: () => server.latestTemplate(),
  log,
  onStatusChange: (patch) => {
    Object.assign(server.status, patch);
    server.sendStatus();
  },
});

const server = createAppServer({
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

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  log('shutting down…');
  await downloader.drain();
  await server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

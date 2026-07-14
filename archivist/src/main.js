import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { runCli } from './cli.js';
import { createArchivistServer } from './server.js';

export async function startArchivist({ dir = undefined } = {}) {
  const { config, firstRun, file } = loadConfig(dir);
  if (firstRun) {
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log('  Archivist — FIRST RUN');
    console.log('');
    console.log(`  API token:  ${config.api_token}`);
    console.log(`  Config:     ${file}`);
    console.log('════════════════════════════════════════════════════════════');
    console.log('');
  }
  const library = openDb(config.db_path);
  console.log(`Archivist library: ${config.db_path}`, library.stats());
  const server = createArchivistServer({ library, config, host: config.bind_host, port: config.port, log: console.warn });
  await server.ready;
  console.log(`Archivist listening on http://${config.bind_host}:${server.port}`);
  return {
    config,
    library,
    server,
    shutdown: async () => {
      await server.close();
      library.close();
    },
  };
}

const entryPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
const COMMANDS = new Set(['ingest-client', 'stats', 'verify', 'rebuild-fts', 'rebuild-threads', 'rebuild-thumbs', 'serve', '--help', '-h', 'help']);

if (entryPath) {
  if (COMMANDS.has(process.argv[2])) {
    const code = await runCli(process.argv.slice(2)).catch((error) => {
      console.error(String(error?.message ?? error));
      return 1;
    });
    process.exit(code);
  } else {
    await startArchivist();
  }
}

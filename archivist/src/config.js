import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8470;

export function configDir() {
  return process.env.ARCHIVIST_DIR || path.join(homedir(), '.archivist');
}

export function defaultConfig(dir) {
  return {
    bind_host: '0.0.0.0',
    port: DEFAULT_PORT,
    api_token: randomBytes(16).toString('hex'),
    archive_root: path.join(dir, 'archive'),
    db_path: path.join(dir, 'library.sqlite3'),
    thumbs_dir: path.join(dir, 'thumbs'),
    log_level: 'info',
  };
}

function applyEnv(config) {
  return {
    ...config,
    bind_host: process.env.ARCHIVIST_BIND_HOST || config.bind_host,
    port: process.env.ARCHIVIST_PORT ? Number(process.env.ARCHIVIST_PORT) : config.port,
    api_token: process.env.ARCHIVIST_API_TOKEN || config.api_token,
    archive_root: process.env.ARCHIVIST_ARCHIVE_ROOT || config.archive_root,
    db_path: process.env.ARCHIVIST_DB_PATH || config.db_path,
    thumbs_dir: process.env.ARCHIVIST_THUMBS_DIR || config.thumbs_dir,
    log_level: process.env.ARCHIVIST_LOG_LEVEL || config.log_level,
  };
}

export function loadConfig(dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const defaults = defaultConfig(dir);
  let config;
  let firstRun = false;
  try {
    config = { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    config = defaults;
    firstRun = true;
  }
  if (firstRun) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { config: applyEnv(config), firstRun, file };
}

/**
 * config.js — companion-app configuration (plan 06 §2 auth + §7 M1).
 *
 * Stored at <dir>/config.json where dir = $TWMD_APP_DIR or ~/.twmd-app.
 * On first run a pairing token is generated and PRINTED — the user pastes
 * it into the extension once (for now: localStorage 'twmd_app_token';
 * the options-page UI is a later step).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 8465;
export const DEFAULT_BIND_HOST = '127.0.0.1';
export const DEFAULT_LOG_LEVEL = 'info';

export function configDir() {
  return process.env.TWMD_APP_DIR || path.join(homedir(), '.twmd-app');
}

export function defaultConfig(dir) {
  return {
    bind_host: DEFAULT_BIND_HOST,
    port: DEFAULT_PORT,
    token: randomBytes(16).toString('hex'),
    archive_root: path.join(dir, 'archive'),
    db_path: path.join(dir, 'library.sqlite3'),
    log_level: DEFAULT_LOG_LEVEL,
    own_accounts: [],
    archivist_url: '',
    archivist_token: '',
  };
}

function applyEnvOverrides(config) {
  return {
    ...config,
    bind_host: process.env.TWMD_APP_HOST || process.env.TWMD_BIND_HOST || config.bind_host,
    port: process.env.TWMD_APP_PORT ? Number(process.env.TWMD_APP_PORT) : config.port,
    archive_root: process.env.TWMD_ARCHIVE_ROOT || config.archive_root,
    db_path: process.env.TWMD_DB_PATH || config.db_path,
    log_level: process.env.TWMD_LOG_LEVEL || config.log_level,
    archivist_url: process.env.TWMD_ARCHIVIST_URL || config.archivist_url,
    archivist_token: process.env.TWMD_ARCHIVIST_TOKEN || config.archivist_token,
  };
}

/** Load config, creating dir + config.json (with a fresh token) on first run. */
export function loadConfig(dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const defaults = defaultConfig(dir);
  let config;
  let firstRun = false;
  try {
    config = { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    config = defaults;
    firstRun = true;
  }
  if (firstRun) {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { config: applyEnvOverrides(config), firstRun, file };
}

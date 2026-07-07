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

export function configDir() {
  return process.env.TWMD_APP_DIR || path.join(homedir(), '.twmd-app');
}

export function defaultConfig(dir) {
  return {
    port: DEFAULT_PORT,
    token: randomBytes(16).toString('hex'),
    archive_root: path.join(dir, 'archive'),
    db_path: path.join(dir, 'library.sqlite3'),
  };
}

/** Load config, creating dir + config.json (with a fresh token) on first run. */
export function loadConfig(dir = configDir()) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let config;
  let firstRun = false;
  try {
    config = { ...defaultConfig(dir), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    config = defaultConfig(dir);
    firstRun = true;
  }
  if (firstRun) {
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { config, firstRun, file };
}

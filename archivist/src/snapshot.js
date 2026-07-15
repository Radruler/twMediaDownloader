import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { toArchivistPost } from '@twmd/core';

function candidatePaths(clientDir, archiveRoot, recordedPath) {
  const paths = [];
  if (recordedPath) {
    paths.push(path.isAbsolute(recordedPath) ? recordedPath : path.join(archiveRoot, recordedPath));
    const parts = recordedPath.split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) paths.push(path.join(archiveRoot, parts[parts.length - 2], parts[parts.length - 1]));
  }
  if (recordedPath && !path.isAbsolute(recordedPath)) paths.push(path.join(clientDir, recordedPath));
  return [...new Set(paths)];
}

function resolveRecordedPath(clientDir, row) {
  const archiveRoot = path.join(clientDir, 'archive');
  return candidatePaths(clientDir, archiveRoot, row.path).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Relation subjects come from the CLIENT's config (archivist-client-plan
 * §C-3: own accounts are operator-declared there, never guessed). A
 * snapshot dir carries that config.json alongside the library.
 */
async function readOwnAccounts(clientDir, log) {
  try {
    const raw = await readFile(path.join(clientDir, 'config.json'), 'utf8');
    const accounts = JSON.parse(raw)?.own_accounts;
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    log(`snapshot: no readable client config.json (${String(error?.message ?? error)}); ingesting without relations`);
    return [];
  }
}

export async function ingestClientDir(ingest, clientDir, { log = () => {} } = {}) {
  const dbPath = path.join(clientDir, 'library.sqlite3');
  const client = new Database(dbPath, { readonly: true, fileMustExist: true });
  const archivistDb = ingest.library.raw;
  const started = Date.now();
  const result = { new: 0, updated: 0, skipped: 0, missing_files: 0, errors: 0 };
  const ownAccounts = await readOwnAccounts(clientDir, log);
  try {
    const posts = client.prepare("SELECT * FROM posts WHERE state = 'archived' ORDER BY last_seen_at, post_key").all();
    const versionsForPost = client.prepare('SELECT * FROM versions WHERE post_key = ? ORDER BY captured_at_ms, id_str');
    const filesForPost = client.prepare(`
      SELECT f.* FROM files f
      JOIN media m ON m.media_key = f.media_key
      JOIN versions v ON v.id_str = m.id_str
      WHERE v.post_key = ?
      ORDER BY m.position
    `);
    const existsInArchivist = archivistDb.prepare('SELECT 1 FROM posts WHERE service = ? AND service_post_key = ?');
    for (const post of posts) {
      try {
        const records = versionsForPost
          .all(post.post_key)
          .map((row) => JSON.parse(row.raw_record_json))
          .filter(Boolean);
        if (records.length === 0) {
          result.skipped += 1;
          continue;
        }
        const files = filesForPost.all(post.post_key);
        const envelope = toArchivistPost(records, files, ownAccounts);
        envelope.deleted = post.deleted === 1;
        const preexisting = !!existsInArchivist.get(envelope.service, envelope.post_key);
        await ingest.ingestPost(envelope, async (sha256) => {
          const file = files.find((row) => row.sha256 === sha256);
          const resolved = resolveRecordedPath(clientDir, file ?? {});
          if (!resolved) {
            result.missing_files += 1;
            return null;
          }
          return { bytes: await readFile(resolved) };
        });
        if (preexisting) result.updated += 1;
        else result.new += 1;
      } catch (error) {
        result.errors += 1;
        log(`snapshot ingest failed for ${post.post_key}: ${String(error?.message ?? error)}`);
      }
    }
    return result;
  } finally {
    client.close();
    archivistDb
      .prepare('INSERT INTO ingest_runs (source, started_at, finished_at, posts_n, files_n, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run('client-snapshot', started, Date.now(), result.new + result.updated, null, JSON.stringify(result));
  }
}

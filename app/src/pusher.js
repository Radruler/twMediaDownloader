/**
 * pusher.js — opportunistic export of archived posts to Archivist
 * (archivist-client-plan §D). The NAS being unreachable is the NORMAL
 * case: failures back off to the timer, never block archiving, and are
 * logged quietly. Re-delivery is harmless (Archivist ingest is
 * idempotent).
 *
 * Error policy (pinned in the plan appendix):
 *  - HTTP 4xx from Archivist = a poison post: warn once, skip it until the
 *    service restarts, and KEEP GOING — one bad envelope must never block
 *    the queue behind it.
 *  - Network errors / 5xx = Archivist unavailable: abandon the sweep; the
 *    timer is the retry.
 */
import { readFile } from 'node:fs/promises';
import { toArchivistPost } from '@twmd/core';

const POST_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 10 * 60_000;

function authHeaders(config) {
  return { authorization: `Bearer ${config.archivist_token}` };
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function httpError(what, response) {
  const error = new Error(`${what}: HTTP ${response.status}`);
  error.status = response.status;
  return error;
}

async function postEnvelope(fetchImpl, config, envelope) {
  const response = await fetchImpl(joinUrl(config.archivist_url, '/api/ingest/post'), {
    method: 'POST',
    headers: { ...authHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!response.ok) throw httpError('Archivist POST failed', response);
  return response.json();
}

async function putFile(fetchImpl, config, sha256, bytes) {
  const response = await fetchImpl(joinUrl(config.archivist_url, `/api/ingest/file/${sha256}`), {
    method: 'PUT',
    headers: authHeaders(config),
    body: bytes,
    signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
  });
  if (!response.ok) throw httpError(`Archivist file upload failed for ${sha256}`, response);
}

function recordsForPost(db, post_key) {
  return db.getExportVersions(post_key).map((row) => JSON.parse(row.raw_record_json));
}

function isPoison(error) {
  return typeof error?.status === 'number' && error.status >= 400 && error.status < 500;
}

export function createArchivistPusher({
  db,
  config,
  log = () => {},
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  intervalMs = 15 * 60 * 1000,
  autoStart = true,
}) {
  let running = false;
  let timer = null;
  /** post_keys that got a 4xx this process lifetime — skipped until restart. */
  const poisoned = new Set();

  async function pushOne(post_key) {
    const records = recordsForPost(db, post_key);
    if (records.length === 0) return false;
    const files = db.filesForPost(post_key);
    const envelope = toArchivistPost(records, files, config.own_accounts ?? []);
    const post = db.getPost(post_key);
    if (post?.deleted) envelope.deleted = true;
    let result = await postEnvelope(fetchImpl, config, envelope);
    for (const sha of result.missing_files ?? []) {
      const file = files.find((row) => row.sha256 === sha);
      if (!file?.path) {
        const error = new Error(`no local file path for ${sha}`);
        error.status = 400; // treat as poison: retrying cannot fix it
        throw error;
      }
      await putFile(fetchImpl, config, sha, await readFileImpl(file.path));
    }
    if ((result.missing_files ?? []).length > 0) {
      result = await postEnvelope(fetchImpl, config, envelope);
    }
    if ((result.missing_files ?? []).length === 0) {
      db.markExportAcked(post_key);
      return true;
    }
    return false;
  }

  async function sweep({ limit = 20 } = {}) {
    if (!config.archivist_url || !config.archivist_token) return { pushed: 0, skipped: 0 };
    if (running) return { pushed: 0, skipped: 0 };
    running = true;
    let pushed = 0;
    let skipped = 0;
    try {
      for (const row of db.dirtyExports(limit)) {
        if (poisoned.has(row.post_key)) {
          skipped += 1;
          continue;
        }
        try {
          if (await pushOne(row.post_key)) pushed += 1;
          else skipped += 1;
        } catch (error) {
          skipped += 1;
          if (isPoison(error)) {
            poisoned.add(row.post_key);
            log(`Archivist push poisoned ${row.post_key} (skipped until restart): ${String(error?.message ?? error)}`);
            continue;
          }
          log(`Archivist push unavailable, abandoning sweep at ${row.post_key}: ${String(error?.message ?? error)}`);
          break;
        }
      }
      return { pushed, skipped };
    } finally {
      running = false;
    }
  }

  function wake() {
    void sweep();
  }

  function start() {
    if (!autoStart || timer || !config.archivist_url || !config.archivist_token) return;
    timer = setInterval(wake, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  start();
  return { sweep, wake, stop };
}

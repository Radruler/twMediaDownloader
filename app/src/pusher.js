import { readFile } from 'node:fs/promises';
import { toArchivistPost } from '@twmd/core';

function authHeaders(config) {
  return { authorization: `Bearer ${config.archivist_token}` };
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

async function postEnvelope(fetchImpl, config, envelope) {
  const response = await fetchImpl(joinUrl(config.archivist_url, '/api/ingest/post'), {
    method: 'POST',
    headers: { ...authHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  if (!response.ok) throw new Error(`Archivist POST failed: HTTP ${response.status}`);
  return response.json();
}

async function putFile(fetchImpl, config, sha256, bytes) {
  const response = await fetchImpl(joinUrl(config.archivist_url, `/api/ingest/file/${sha256}`), {
    method: 'PUT',
    headers: authHeaders(config),
    body: bytes,
  });
  if (!response.ok) throw new Error(`Archivist file upload failed for ${sha256}: HTTP ${response.status}`);
}

function recordsForPost(db, post_key) {
  return db.getExportVersions(post_key).map((row) => JSON.parse(row.raw_record_json));
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

  async function pushOne(post_key) {
    const records = recordsForPost(db, post_key);
    if (records.length === 0) return false;
    const files = db.filesForPost(post_key);
    const envelope = toArchivistPost(records, files, config.own_accounts ?? []);
    let result = await postEnvelope(fetchImpl, config, envelope);
    for (const sha of result.missing_files ?? []) {
      const file = files.find((row) => row.sha256 === sha);
      if (!file?.path) throw new Error(`no local file path for ${sha}`);
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
        try {
          if (await pushOne(row.post_key)) pushed += 1;
          else skipped += 1;
        } catch (error) {
          skipped += 1;
          log(`Archivist push skipped ${row.post_key}: ${String(error?.message ?? error)}`);
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

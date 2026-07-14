/**
 * downloader.js — the M2 archive queue (plan 06 §4).
 *
 * Politeness/parity rules (Decisions 20/22 — HARD constraints):
 *   - CDN hosts ONLY (pbs.twimg.com / video.twimg.com) — any other host is
 *     refused outright; the app can never contact x.com;
 *   - ≤2 concurrent requests, 500–1500 ms jittered gap after each one;
 *   - headers come from the freshest request_template (already sanitized
 *     server-side; cookie/authorization-like names are stripped AGAIN here
 *     — defense in depth, cookies are never forwarded);
 *   - retry 3× with backoff, then archive_failed. No background re-tries
 *     later — the user re-queues manually;
 *   - 404/410 → the post is flagged deleted (passive detection,
 *     Decision 18).
 */

import { planMediaDownload } from '@twmd/core';

const ALLOWED_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);

export function isAllowedCdnUrl(url) {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

function stripCredentialHeaders(headers) {
  const clean = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (/cookie|authorization|auth[-_]?token|x-csrf/i.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDownloader({
  db,
  writer,
  getTemplate = /** @type {() => any} */ (() => null),
  log = () => {},
  onStatusChange = () => {},
  fetchImpl = globalThis.fetch,
  concurrency = 2,
  gapMs = () => 500 + Math.floor(Math.random() * 1000),
  maxRetries = 3,
  retryBaseMs = 1000,
  onArchived = () => {},
}) {
  const queue = [];
  const runs = new Map(); // run_id -> { label, started_at }
  let active = 0;
  let archivedCount = 0;
  let stopping = false;
  let drainResolvers = [];

  function statusPatch(patch = {}) {
    onStatusChange({ queue_depth: queue.length + active, archived_count: archivedCount, ...patch });
  }

  function headers() {
    return stripCredentialHeaders(getTemplate()?.headers);
  }

  /**
   * One CDN GET with retries. Returns
   * { bytes } | { gone: true } | { error }.
   */
  async function fetchWithRetries(url) {
    if (!isAllowedCdnUrl(url)) {
      return { error: `refused non-CDN url host: ${url}` };
    }
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(retryBaseMs * 2 ** (attempt - 1));
      try {
        const response = await fetchImpl(url, { headers: headers(), redirect: 'follow' });
        await sleep(gapMs()); // politeness gap after every request
        if (response.status === 404 || response.status === 410) {
          return { gone: true };
        }
        if (response.ok) {
          return { bytes: Buffer.from(await response.arrayBuffer()) };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        await sleep(gapMs());
        lastError = String(error && error.message ? error.message : error);
      }
    }
    return { error: `${lastError} (after ${maxRetries + 1} attempts): ${url}` };
  }

  /** Archive one post: all media + sidecar. */
  async function processJob(job) {
    const { record, post_key, run_id } = job;
    const run = run_id ? runs.get(run_id) ?? null : null;
    const savedBasenames = [];
    let failures = 0;
    let goneCount = 0;

    for (const media of record.media) {
      const plan = planMediaDownload(media);
      if (!plan) {
        log(`no downloadable URL for ${post_key} media ${media.index} — skipped`);
        continue;
      }
      let saved = false;
      let sawGone = false;
      for (const url of plan.urls) {
        const result = await fetchWithRetries(url);
        if (result.bytes) {
          const written = await writer.writeMedia({
            record,
            media,
            ext: plan.ext,
            bytes: result.bytes,
            media_key: media.media_key ?? `${record.id_str}:${media.index}`,
            run,
          });
          savedBasenames.push(written.basename);
          log(
            written.deduped
              ? `dedupe hit for ${written.basename} (already at ${written.path})`
              : `saved ${written.path}`,
          );
          saved = true;
          break;
        }
        if (result.gone) {
          sawGone = true;
          continue; // photos: fall through orig -> 4096x4096 -> large
        }
        log(`download failed: ${result.error}`);
        break; // non-404 failure: retries are already exhausted — don't hammer fallbacks
      }
      if (!saved) {
        failures += 1;
        if (sawGone) goneCount += 1;
      }
    }

    if (goneCount > 0) {
      db.markDeleted(record.id_str);
      log(`media gone (404/410) for ${post_key} — flagged deleted (Decision 18)`);
    }

    if (savedBasenames.length > 0 || record.media.length === 0) {
      await writer.writeSidecars({ record, savedBasenames, run });
      db.setPostState(post_key, failures === 0 ? 'archived' : 'archive_failed');
      if (failures === 0) {
        archivedCount += 1;
        onArchived(post_key);
      }
    } else {
      db.setPostState(post_key, 'archive_failed');
    }
  }

  async function worker() {
    active += 1;
    try {
      while (!stopping && queue.length > 0) {
        const job = queue.shift();
        statusPatch();
        try {
          await processJob(job);
        } catch (error) {
          db.setPostState(job.post_key, 'archive_failed');
          const message = String(error && error.message ? error.message : error);
          log(`archive job crashed for ${job.post_key}: ${message}`);
          statusPatch({ last_error: message });
        }
      }
    } finally {
      active -= 1;
      statusPatch();
      if (active === 0 && queue.length === 0) {
        for (const resolve of drainResolvers) resolve();
        drainResolvers = [];
      }
    }
  }

  return {
    enqueue(request) {
      if (stopping) return;
      queue.push(request);
      statusPatch();
      const want = Math.min(concurrency, queue.length);
      while (active < want) void worker();
    },

    setRun(runId, phase, label) {
      if (phase === 'begin') runs.set(runId, { label, started_at: Date.now() });
      // 'end': keep the entry — late archive frames for the run still route
      // to its folder; runs are tiny {label, started_at} records.
    },

    queueDepth() {
      return queue.length + active;
    },

    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => drainResolvers.push(resolve));
    },

    shutdown() {
      stopping = true;
      queue.length = 0;
      statusPatch();
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => drainResolvers.push(resolve));
    },
  };
}

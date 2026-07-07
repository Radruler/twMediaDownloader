/**
 * save.js — standalone save layer (plan 04, step 3b).
 *
 * Flow: tweet id -> TweetCache.get -> planMediaDownload per media item ->
 * fetch the bytes HERE in the content script (plain `fetch(url)` — no
 * custom headers, browser-managed cookies: indistinguishable from the user
 * opening the image; request-parity rule, plan 02) -> data: URLs -> the
 * save-worker service-worker port -> chrome.downloads writes
 * Downloads/twMediaDownloader/<screen_name>/<legacy-convention names>
 * with conflictAction 'uniquify' (Decisions 8/9).
 *
 * Sidecar .txt is on by default (Decision 7); options.sidecar:
 * 'txt' | 'json' | 'both' | 'none'.
 *
 * Transport is a chrome.runtime.connect port (name 'twmd-save') rather than
 * sendMessage: the legacy background listener (src/js/background.js —
 * untouched by design) answers EVERY unknown sendMessage type synchronously
 * with {result:'NG'}, which would close the response channel before the
 * async download results exist. Ports are namespaced; no interference.
 */

import {
  mediaBasename,
  planMediaDownload,
  sidecarBasename,
  sidecarJsonText,
  sidecarTxt,
  standaloneRelativePath,
} from '@twmd/core';
import { TweetCache } from './tweet-cache.js';

export const SAVE_PORT_NAME = 'twmd-save';

const SIDECAR_MIME = { txt: 'text/plain', json: 'application/json' };

/**
 * Pure planning step (unit-tested without any browser API): what files a
 * save of `record` produces. Media fetching/downloading happens later.
 * Returns { media: [{ media, plan, basename, filename }],
 *           sidecars: [{ format, basename, filename, text }],
 *           skipped: [{ media_key, index, reason }] }
 */
export function buildSaveManifest(record, { sidecar = 'txt' } = {}) {
  const parts = {
    screen_name: record.user.screen_name,
    tweet_id: record.id_str,
    created_at_ms: record.created_at_ms,
  };
  const media = [];
  const skipped = [];
  for (const item of record.media) {
    const plan = planMediaDownload(item);
    if (!plan) {
      skipped.push({ media_key: item.media_key, index: item.index, reason: 'no downloadable URL' });
      continue;
    }
    const basename = mediaBasename(parts, item, plan.ext);
    media.push({
      media: item,
      plan,
      basename,
      filename: standaloneRelativePath(record.user.screen_name, basename),
    });
  }

  const formats = sidecar === 'both' ? ['txt', 'json'] : sidecar === 'none' ? [] : [sidecar];
  const savedFiles = [
    ...media.map((m) => m.basename),
    ...formats.map((format) => sidecarBasename(parts, format)),
  ];
  const sidecars = formats.map((format) => {
    const basename = sidecarBasename(parts, format);
    return {
      format,
      basename,
      filename: standaloneRelativePath(record.user.screen_name, basename),
      text:
        format === 'txt'
          ? sidecarTxt(record, { saved_files: savedFiles })
          : sidecarJsonText(record, { saved_files: savedFiles }),
    };
  });
  return { media, sidecars, skipped };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Try each URL in order (photo orig -> 4096x4096 -> large); first 2xx wins. */
async function fetchFirstOk(urls) {
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url); // plain GET, no init — request parity
      if (response.ok) return { url, blob: await response.blob() };
      lastError = `HTTP ${response.status} for ${url}`;
    } catch (error) {
      lastError = `${error} for ${url}`;
    }
  }
  return { error: lastError ?? 'no URLs to try' };
}

/** One request/response round-trip over the save port. */
function sendToSaveWorker(items, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: SAVE_PORT_NAME });
    } catch (error) {
      reject(new Error(`cannot reach service worker: ${error}`));
      return;
    }
    const timer = setTimeout(() => {
      try {
        port.disconnect();
      } catch (e) {
        /* already gone */
      }
      reject(new Error('save-worker timed out'));
    }, timeoutMs);
    port.onMessage.addListener((message) => {
      if (!message || message.type !== 'save_result') return;
      clearTimeout(timer);
      resolve(message.results);
      try {
        port.disconnect();
      } catch (e) {
        /* already gone */
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      reject(new Error('save-worker port disconnected before responding'));
    });
    port.postMessage({ v: 1, type: 'save', items });
  });
}

/**
 * Save every media item of a cached tweet plus its sidecar(s).
 * Returns { ok, saved: [{filename, downloadId}], failures: [...] }.
 */
export async function saveTweet(tweetId, options = {}) {
  const record = TweetCache.get(String(tweetId));
  if (!record) {
    return {
      ok: false,
      error: `tweet ${tweetId} is not in the cache — scroll it into view first (plan 02 §5)`,
    };
  }
  const manifest = buildSaveManifest(record, options);
  const items = [];
  const failures = manifest.skipped.map((s) => ({ ...s })); // copy

  for (const entry of manifest.media) {
    const fetched = await fetchFirstOk(entry.plan.urls);
    if (fetched.error) {
      failures.push({ media_key: entry.media.media_key, index: entry.media.index, reason: fetched.error });
      continue;
    }
    items.push({ url: await blobToDataUrl(fetched.blob), filename: entry.filename });
  }
  for (const sidecar of manifest.sidecars) {
    const blob = new Blob([sidecar.text], { type: `${SIDECAR_MIME[sidecar.format]};charset=utf-8` });
    items.push({ url: await blobToDataUrl(blob), filename: sidecar.filename });
  }

  if (items.length === 0) {
    return { ok: false, error: 'nothing fetchable to save', failures };
  }
  try {
    const results = await sendToSaveWorker(items);
    const saved = results.filter((r) => r.ok);
    for (const r of results) {
      if (!r.ok) failures.push({ filename: r.filename, reason: r.error });
    }
    return { ok: saved.length > 0, saved, failures };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), failures };
  }
}

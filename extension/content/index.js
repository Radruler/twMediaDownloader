/**
 * index.js — isolated-world content-script entry (document_start).
 *
 * Wires the capture pipeline: page-interceptor CustomEvents -> core
 * normalizer -> TweetCache singleton. Also hosts the debug surface:
 *
 *   localStorage.twmd_debug_overlay = '1'   -> on-page stats overlay
 *   localStorage.twmd_capture_fixtures = '1'-> overlay grows "save fixture"
 *                                              buttons (docs/CAPTURE_FIXTURES.md)
 *   localStorage.twmd_debug = '1'           -> unlisted-op telemetry + console logs
 *
 * DevTools access (pick this extension's context in the console dropdown):
 *   window.__twmdDebug.stats() / .last() / .tombstones() / .rawPayloads()
 */

import { normalizePayload } from '@twmd/core';
import { TweetCache } from './tweet-cache.js';
import { saveTweet } from './save.js';
import {
  APP_HOST_KEY,
  APP_PORT_KEY,
  APP_TOKEN_KEY,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  createAppClient,
} from './app-client.js';

const LAST_IDS_MAX = 25;
const TOMBSTONES_MAX = 100;

const state = {
  payloadsByOp: new Map(), // op -> count
  lastCaptured: [], // [{ id_str, screen_name, op, media, at }]
  tombstones: [], // TombstoneEvent[]
  unlistedOps: new Map(), // op -> count (debug mode only)
  rawByOp: new Map(), // op -> { url, ts, body } (fixture-capture mode only)
  parseErrors: 0,
};

function flag(name) {
  try {
    return localStorage.getItem(name) === '1';
  } catch (e) {
    return false;
  }
}

function debugLog(...args) {
  if (flag('twmd_debug')) console.log('[twmd]', ...args);
}

// ---- companion-app link (plan 06, step C3) ----
// Token set = connected mode; unset = pure standalone (invariant: the app
// only ever UPGRADES — every feature works without it).

function localStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

const appClient = createAppClient({
  token: localStorageGet(APP_TOKEN_KEY),
  host: localStorageGet(APP_HOST_KEY) || DEFAULT_APP_HOST,
  port: Number(localStorageGet(APP_PORT_KEY)) || DEFAULT_APP_PORT,
  extVersion: (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return 'dev';
    }
  })(),
  log: (...args) => debugLog('[app]', ...args),
});
appClient.start();
TweetCache.onUpdate((tweetId, record) => appClient.sendSeen(record));

// Forward the browser's observed media-request shape to the app (plan 06
// request_template; captured observation-only in the background worker).
const TEMPLATE_POLL_MS = 5 * 60 * 1000;

function forwardRequestTemplate() {
  if (!appClient.state.connected) return;
  try {
    const port = chrome.runtime.connect({ name: 'twmd-template' });
    port.onMessage.addListener((message) => {
      if (message && message.type === 'template' && message.template) {
        appClient.sendRequestTemplate(message.template.headers, message.template.observed_at);
      }
      try {
        port.disconnect();
      } catch (e) {
        /* already gone */
      }
    });
    port.postMessage({ type: 'get_template' });
  } catch (e) {
    /* extension context gone (page unloading) — next poll retries */
  }
}

if (appClient.state.enabled) {
  setTimeout(forwardRequestTemplate, 10_000);
  setInterval(forwardRequestTemplate, TEMPLATE_POLL_MS);
}

document.addEventListener('twmd:graphql', (event) => {
  try {
    const message = JSON.parse(event.detail);
    if (!message || message.v !== 1 || typeof message.body !== 'string') return;
    ingest(message);
  } catch (e) {
    state.parseErrors += 1;
  }
});

document.addEventListener('twmd:graphql-unlisted', (event) => {
  try {
    const message = JSON.parse(event.detail);
    if (!message || typeof message.op !== 'string') return;
    state.unlistedOps.set(message.op, (state.unlistedOps.get(message.op) || 0) + 1);
    debugLog('unlisted GraphQL op (extend the interceptor pass-list?):', message.op);
  } catch (e) {
    /* ignore */
  }
});

function ingest(message) {
  let payload;
  try {
    payload = JSON.parse(message.body);
  } catch (e) {
    state.parseErrors += 1;
    return;
  }
  if (flag('twmd_capture_fixtures')) {
    state.rawByOp.set(message.op, { url: message.url, ts: message.ts, body: payload });
  }
  const { tweets, tombstones } = normalizePayload(payload, message.op, Date.now());
  state.payloadsByOp.set(message.op, (state.payloadsByOp.get(message.op) || 0) + 1);
  for (const record of tweets) {
    TweetCache.put(record);
    state.lastCaptured.unshift({
      id_str: record.id_str,
      screen_name: record.user.screen_name,
      op: record.source_op,
      media: record.media.length,
      at: record.captured_at_ms,
    });
  }
  state.lastCaptured.length = Math.min(state.lastCaptured.length, LAST_IDS_MAX);
  for (const tombstone of tombstones) {
    state.tombstones.unshift(tombstone);
    if (tombstone.tweet_id) appClient.sendTombstone(tombstone);
    debugLog('tombstone captured:', tombstone.tweet_id, tombstone.text);
  }
  state.tombstones.length = Math.min(state.tombstones.length, TOMBSTONES_MAX);
  debugLog(`captured ${message.op}: ${tweets.length} tweet(s), ${tombstones.length} tombstone(s)`);
  scheduleOverlayRender();
}

// ---- debug surface (console) ----

window.__twmdDebug = {
  stats: () => TweetCache.stats(),
  last: (n = 10) => state.lastCaptured.slice(0, n),
  tombstones: () => state.tombstones.slice(),
  payloadsByOp: () => Object.fromEntries(state.payloadsByOp),
  unlistedOps: () => Object.fromEntries(state.unlistedOps),
  rawPayloads: () => [...state.rawByOp.keys()],
  get: (id) => TweetCache.get(id),
  /**
   * Temporary debug trigger for the save layer (plan 04 B4) until the 3a UI
   * exists: __twmdDebug.save('<tweet id>') saves all media + sidecar to
   * Downloads/twMediaDownloader/<screen_name>/.
   * options.sidecar: 'txt' (default) | 'json' | 'both' | 'none'.
   */
  save: (id, options) =>
    saveTweet(id, options).then((result) => {
      console.log('[twmd] save result:', result);
      return result;
    }),
  /** Companion-app link state: connection, buffered archives, last status frame. */
  app: () => ({
    ...appClient.state,
    archive_buffer: appClient.archiveBufferSize(),
  }),
  /** Queue a tweet for archiving by the companion app (buffered if offline). */
  archive: (id, reason = 'button') => {
    const record = TweetCache.get(String(id));
    if (!record) return `tweet ${id} not in cache`;
    appClient.sendArchive(record, reason);
    return 'queued';
  },
};

// ---- debug overlay ----

let overlayRoot = null;
let renderQueued = false;

function scheduleOverlayRender() {
  if (!flag('twmd_debug_overlay') || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    try {
      renderOverlay();
    } catch (e) {
      /* the overlay must never break the page */
    }
  }, 250);
}

function ensureOverlayRoot() {
  if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
  overlayRoot = document.createElement('div');
  overlayRoot.id = 'twmd-debug-overlay';
  overlayRoot.style.cssText = [
    'position:fixed', 'bottom:12px', 'right:12px', 'z-index:2147483647',
    'max-width:340px', 'max-height:50vh', 'overflow:auto',
    'background:rgba(0,0,0,0.85)', 'color:#7fdb7f',
    'font:11px/1.5 monospace', 'padding:8px 10px', 'border-radius:6px',
    'pointer-events:auto', 'white-space:pre-wrap',
  ].join(';');
  (document.body || document.documentElement).appendChild(overlayRoot);
  return overlayRoot;
}

function renderOverlay() {
  const root = ensureOverlayRoot();
  root.textContent = '';

  const stats = TweetCache.stats();
  const header = document.createElement('div');
  const ops = [...state.payloadsByOp.entries()].map(([op, n]) => `${op}:${n}`).join(' ');
  header.textContent =
    `Archivist Client capture — cache ${stats.size} (hitRate ${stats.hitRate.toFixed(2)})\n` +
    `payloads: ${ops || '(none yet — scroll a timeline)'}\n` +
    `tombstones: ${state.tombstones.length}  parse errors: ${state.parseErrors}`;
  root.appendChild(header);

  const list = document.createElement('div');
  list.style.cssText = 'margin-top:6px;color:#9fd6ff';
  list.textContent = state.lastCaptured
    .slice(0, 10)
    .map((t) => `${t.id_str} @${t.screen_name ?? '?'} [${t.op}] media:${t.media}`)
    .join('\n');
  root.appendChild(list);

  if (flag('twmd_capture_fixtures') && state.rawByOp.size > 0) {
    const captureBox = document.createElement('div');
    captureBox.style.cssText = 'margin-top:6px;border-top:1px solid #444;padding-top:6px';
    captureBox.textContent = 'fixture capture (saves last payload per op):\n';
    for (const op of [...state.rawByOp.keys()].sort()) {
      const button = document.createElement('button');
      button.textContent = `save ${op}`;
      button.style.cssText =
        'margin:2px 4px 2px 0;font:11px monospace;cursor:pointer;' +
        'background:#222;color:#7fdb7f;border:1px solid #555;border-radius:3px;padding:1px 6px';
      button.addEventListener('click', () => saveFixture(op));
      captureBox.appendChild(button);
    }
    root.appendChild(captureBox);
  }
}

/** Download the last raw payload for an op as a fixture file (see docs/CAPTURE_FIXTURES.md). */
function saveFixture(op) {
  try {
    const raw = state.rawByOp.get(op);
    if (!raw) return;
    const fixture = {
      __fixture: {
        op,
        captured_at: new Date(raw.ts).toISOString(),
        note: 'REAL capture from x.com — REDACT before committing (docs/CAPTURE_FIXTURES.md)',
      },
      ...raw.body,
    };
    const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `twmd-fixture-${op}-${raw.ts}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    debugLog('fixture save failed', e);
  }
}

if (flag('twmd_debug_overlay')) {
  const start = () => scheduleOverlayRender();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

// ---- step-3a scaffolding: EXPERIMENTAL, selectors unverified ----
// localStorage.twmd_experimental_buttons = '1' enables the injection
// framework skeleton (see extension/content/ui-buttons.js header).
if (flag('twmd_experimental_buttons')) {
  import('./ui-buttons.js').then(({ createButtonInjector }) => {
    const injector = createButtonInjector({
      onDownload: (id) => saveTweet(id),
      log: (...args) => debugLog('[buttons]', ...args),
    });
    const startInjector = () => injector.start();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startInjector);
    } else {
      startInjector();
    }
  });
}

debugLog('capture pipeline ready');

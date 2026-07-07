/**
 * app-client.js — extension side of the companion-app link (plan 06 §2,
 * step C3). Pure upgrade path: no token configured = the client never
 * starts and the extension is fully standalone (invariant, plan 06 §1).
 *
 * Pairing token comes from localStorage 'twmd_app_token' for now (the
 * options-page UI is a separate step); port override: 'twmd_app_port'.
 *
 * Behavior:
 *  - connect to ws://127.0.0.1:<port>, first frame `hello` w/ token;
 *  - wait for hello_ack before sending anything else;
 *  - exponential-backoff reconnect (1s → 60s cap, jittered);
 *  - `seen` frames are fire-and-forget (dropped while disconnected —
 *    plan 06 §2 offline rule);
 *  - `archive` frames buffer up to 200 while disconnected and replay
 *    in order on reconnect (oldest dropped past the cap);
 *  - a bad_token error stops reconnecting until restart (never hammer).
 *
 * The WebSocket implementation is injectable so the protocol loop is
 * unit-testable in Node against the real app server.
 */

export const APP_TOKEN_KEY = 'twmd_app_token';
export const APP_PORT_KEY = 'twmd_app_port';
export const DEFAULT_APP_PORT = 8465;
export const PROTOCOL_VERSION = 1;
export const ARCHIVE_BUFFER_MAX = 200;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

/** @param {any} [options] */
export function createAppClient({
  token,
  port = DEFAULT_APP_PORT,
  WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null,
  extVersion = 'dev',
  coreVersion = '0.1.0',
  log = () => {},
  backoffBaseMs = BACKOFF_BASE_MS,
} = {}) {
  const state = {
    enabled: Boolean(token) && Boolean(WebSocketImpl),
    connected: false, // hello_ack received
    attempts: 0,
    fatal: null, // e.g. 'bad_token' — stop reconnecting
    lastStatus: null, // latest app status frame
    sent: { seen: 0, archive: 0, tombstone: 0 },
    dropped: { seen: 0, archive: 0 },
  };
  const archiveBuffer = [];
  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  function send(frame) {
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function flushArchiveBuffer() {
    while (archiveBuffer.length > 0 && state.connected) {
      const frame = archiveBuffer[0];
      if (!send(frame)) break;
      archiveBuffer.shift();
      state.sent.archive += 1;
    }
  }

  function scheduleReconnect() {
    if (stopped || state.fatal || reconnectTimer) return;
    const delay =
      Math.min(BACKOFF_CAP_MS, backoffBaseMs * 2 ** Math.min(state.attempts, 6)) *
      (0.75 + Math.random() * 0.5);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function connect() {
    if (stopped || state.fatal || !state.enabled) return;
    state.attempts += 1;
    try {
      ws = new WebSocketImpl(`ws://127.0.0.1:${port}`);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      send({ type: 'hello', token, ext_version: extVersion, core_version: coreVersion });
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      } catch (e) {
        return;
      }
      if (!frame || frame.v !== PROTOCOL_VERSION) return;
      if (frame.type === 'hello_ack') {
        state.connected = true;
        state.attempts = 0;
        log(`app connected (app ${frame.app_version}, core ${frame.core_version})`);
        flushArchiveBuffer();
      } else if (frame.type === 'status') {
        state.lastStatus = frame;
      } else if (frame.type === 'error' && frame.error === 'bad_token') {
        state.fatal = 'bad_token';
        log('app rejected the pairing token — fix twmd_app_token and reload');
      } else if (frame.type === 'error' && frame.error === 'unsupported_version') {
        state.fatal = 'unsupported_version';
        log(`app speaks protocol v${frame.supported}, this extension v${PROTOCOL_VERSION} — update needed`);
      }
    };
    ws.onclose = () => {
      const wasConnected = state.connected;
      state.connected = false;
      ws = null;
      if (wasConnected) log('app disconnected — extension continues standalone');
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows; backoff handles it */
    };
  }

  return {
    state,
    archiveBufferSize: () => archiveBuffer.length,

    start() {
      if (!state.enabled) {
        log('no app token configured — standalone mode');
        return;
      }
      connect();
    },

    /** Fire-and-forget; dropped while disconnected (plan 06 §2). */
    sendSeen(record) {
      if (!state.connected) {
        state.dropped.seen += 1;
        return;
      }
      if (send({ type: 'seen', record })) state.sent.seen += 1;
    },

    /** Buffered while disconnected (≤200, oldest dropped), replayed in order. */
    sendArchive(record, reason = 'button', run_id = /** @type {string|undefined} */ (undefined)) {
      const frame = { type: 'archive', record, reason, ...(run_id ? { run_id } : {}) };
      if (state.connected && send(frame)) {
        state.sent.archive += 1;
        return;
      }
      archiveBuffer.push(frame);
      if (archiveBuffer.length > ARCHIVE_BUFFER_MAX) {
        archiveBuffer.shift();
        state.dropped.archive += 1;
      }
    },

    sendTombstone(event) {
      if (!state.connected) return;
      if (send({ type: 'tombstone', event })) state.sent.tombstone += 1;
    },

    sendBulk(run_id, phase, label = '') {
      if (!state.connected) return;
      send({ type: phase === 'begin' ? 'bulk_begin' : 'bulk_end', run_id, label });
    },

    sendRequestTemplate(headers, observed_at = Date.now()) {
      if (!state.connected) return;
      send({ type: 'request_template', headers, observed_at });
    },

    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          /* already closed */
        }
      }
    },
  };
}

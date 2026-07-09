/**
 * server.js — the extension ⇄ app WebSocket protocol (plan 06 §2).
 *
 * App = server on 127.0.0.1 only; extension = client. All frames are JSON
 * {v: 1, type, ...}. First frame must be `hello` with the pairing token;
 * anything else (or a bad token) drops the connection. Unknown MAJOR
 * versions are rejected with an error frame the extension can surface.
 *
 * Frames handled (ext→app): hello, seen, archive, bulk_begin, bulk_end,
 * request_template, tombstone*. Sent (app→ext): hello_ack, status, error.
 * (*tombstone is a plan amendment: plan 06 §2's table omitted a frame for
 * the normalizer's TombstoneEvents, but §3 requires captured tombstones to
 * set deleted=1.)
 *
 * SECURITY INVARIANTS (Decisions Log): the app never sees x.com traffic or
 * credentials; request_template headers are sanitized here AND at capture —
 * any cookie/authorization-like header is dropped, never stored, never
 * logged.
 */

import { WebSocketServer } from 'ws';

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = '0.1.0';
export const CORE_VERSION = '0.1.0';

const CLOSE_BAD_TOKEN = 4001;
const CLOSE_BAD_VERSION = 4002;
const CLOSE_NOT_HELLO = 4003;

/** Drop any header that could carry credentials. Case-insensitive. */
export function sanitizeTemplateHeaders(headers) {
  const clean = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (/cookie|authorization|auth[-_]?token|x-csrf/i.test(name)) continue;
    if (typeof value !== 'string') continue;
    clean[name] = value;
  }
  return clean;
}

/**
 * Start the protocol server.
 *   options: { port, host='127.0.0.1', token, db, log=console.log,
 *              onArchive(frame), onBulk(run_id, 'begin'|'end', label) }
 * Returns { port, counters, latestTemplate(), activeRuns(), sendStatus(),
 *           close() }.
 */
export function createAppServer({
  port,
  host = '127.0.0.1',
  token,
  db,
  log = () => {},
  onArchive = () => {},
  onBulk = () => {},
}) {
  const wss = new WebSocketServer({ port, host });
  let boundPort = null;
  const ready = new Promise((resolve, reject) => {
    wss.on('listening', () => {
      boundPort = wss.address().port;
      resolve(boundPort);
    });
    wss.on('error', reject);
  });
  const counters = { seen: 0, archive: 0, tombstone: 0, errors: 0 };
  const runs = new Map(); // run_id -> { label, started_at, ended_at? }
  let latestTemplate = null; // { headers, observed_at }
  const status = { queue_depth: 0, last_error: null, archived_count: 0 };

  function send(ws, frame) {
    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    } catch (e) {
      /* connection raced away */
    }
  }

  function sendStatus(ws) {
    const frame = { type: 'status', ...status };
    if (ws) send(ws, frame);
    else for (const client of wss.clients) send(client, frame);
  }

  function handleFrame(ws, state, frame) {
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      counters.errors += 1;
      return;
    }
    if (frame.v !== PROTOCOL_VERSION) {
      send(ws, { type: 'error', error: 'unsupported_version', supported: PROTOCOL_VERSION });
      ws.close(CLOSE_BAD_VERSION, 'unsupported protocol version');
      return;
    }
    if (!state.authed) {
      if (frame.type !== 'hello') {
        ws.close(CLOSE_NOT_HELLO, 'hello required');
        return;
      }
      if (typeof frame.token !== 'string' || frame.token !== token) {
        send(ws, { type: 'error', error: 'bad_token' });
        ws.close(CLOSE_BAD_TOKEN, 'pairing token mismatch');
        log('rejected connection: bad pairing token');
        return;
      }
      state.authed = true;
      send(ws, { type: 'hello_ack', app_version: APP_VERSION, core_version: CORE_VERSION });
      sendStatus(ws);
      log(`extension connected (ext ${frame.ext_version ?? '?'}, core ${frame.core_version ?? '?'})`);
      return;
    }

    switch (frame.type) {
      case 'seen': {
        if (!frame.record || typeof frame.record.id_str !== 'string') break;
        db.ingestSeen(frame.record);
        counters.seen += 1;
        break;
      }
      case 'archive': {
        if (!frame.record || typeof frame.record.id_str !== 'string') break;
        const post_key = db.ingestArchiveRequest(frame.record);
        counters.archive += 1;
        onArchive({ record: frame.record, reason: frame.reason, run_id: frame.run_id, post_key });
        sendStatus();
        break;
      }
      case 'bulk_begin': {
        if (typeof frame.run_id !== 'string') break;
        runs.set(frame.run_id, { label: frame.label ?? '', started_at: Date.now() });
        onBulk(frame.run_id, 'begin', frame.label ?? '');
        log(`bulk run begun: ${frame.run_id} (${frame.label ?? ''})`);
        break;
      }
      case 'bulk_end': {
        const run = runs.get(frame.run_id);
        if (run) run.ended_at = Date.now();
        onBulk(frame.run_id, 'end', run ? run.label : '');
        log(`bulk run ended: ${frame.run_id}`);
        break;
      }
      case 'request_template': {
        latestTemplate = {
          headers: sanitizeTemplateHeaders(frame.headers),
          observed_at: frame.observed_at ?? Date.now(),
        };
        // never log header VALUES — names only
        log(`request template updated (${Object.keys(latestTemplate.headers).join(', ')})`);
        break;
      }
      case 'tombstone': {
        const event = frame.event;
        if (!event || typeof event.tweet_id !== 'string') break;
        if (db.markDeleted(event.tweet_id)) counters.tombstone += 1;
        break;
      }
      default:
        counters.errors += 1;
        send(ws, { type: 'error', error: 'unknown_frame_type', unknown: frame.type });
    }
  }

  wss.on('connection', (ws) => {
    const state = { authed: false, alive: true };
    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch (e) {
        counters.errors += 1;
        return;
      }
      try {
        handleFrame(ws, state, frame);
      } catch (error) {
        counters.errors += 1;
        status.last_error = String(error && error.message ? error.message : error);
        log(`frame handling error: ${status.last_error}`);
      }
    });
    ws._twmdState = state;
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = ws._twmdState;
      if (!state) continue;
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch (e) {
        /* closing */
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    ready,
    get port() {
      return boundPort ?? port;
    },
    counters,
    status,
    latestTemplate: () => latestTemplate,
    activeRuns: () => new Map(runs),
    sendStatus,
    close() {
      clearInterval(heartbeat);
      return new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      });
    },
  };
}

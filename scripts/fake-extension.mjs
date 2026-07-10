/**
 * fake-extension.mjs — replays fixture TweetRecords over the real ws
 * protocol against a RUNNING companion app, standing in for Chrome
 * (plan 06 §7 M1 acceptance without a browser).
 *
 *   node app/dist/main.mjs                # terminal 1 — note the token
 *   node scripts/fake-extension.mjs --token <token> [--host 127.0.0.1] [--port 8465]
 *        [--archive <tweet_id>]           # also send an archive frame
 *        [--tombstone <tweet_id>]         # also send a tombstone
 *
 * Sends every TweetRecord from test/fixtures/graphql/expected/*.json as
 * 'seen' frames (exactly what the extension's cache→client wiring sends),
 * then prints the app's status frame. --archive triggers the real M2
 * downloader — REAL CDN GETs for that tweet's media; use a text-only
 * tweet id if you want a no-network test.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXPECTED_DIR = path.join(root, 'test/fixtures/graphql/expected');

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const token = argValue('token');
const host = argValue('host') ?? '127.0.0.1';
const port = Number(argValue('port') ?? 8465);
const archiveId = argValue('archive');
const tombstoneId = argValue('tombstone');

if (!token) {
  console.error('usage: node scripts/fake-extension.mjs --token <pairing token> [--host HOST] [--port N] [--archive <id>] [--tombstone <id>]');
  process.exit(1);
}

const records = [];
for (const file of readdirSync(EXPECTED_DIR)) {
  const { tweets } = JSON.parse(readFileSync(path.join(EXPECTED_DIR, file), 'utf8'));
  records.push(...tweets);
}
console.log(`loaded ${records.length} TweetRecords from ${EXPECTED_DIR}`);

const ws = new WebSocket(`ws://${host}:${port}`);
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));

ws.on('open', () => {
  send({ type: 'hello', token, ext_version: 'fake-extension', core_version: '0.1.0' });
});

ws.on('message', (data) => {
  const frame = JSON.parse(data.toString());
  if (frame.type === 'hello_ack') {
    console.log(`paired: app ${frame.app_version}, core ${frame.core_version}`);
    for (const record of records) send({ type: 'seen', record });
    console.log(`sent ${records.length} seen frames`);
    if (archiveId) {
      const record = records.find((r) => r.id_str === archiveId);
      if (!record) {
        console.error(`--archive ${archiveId}: not in fixtures`);
      } else {
        send({ type: 'archive', record, reason: 'button' });
        console.log(`sent archive frame for ${archiveId} (${record.media.length} media) — watch the app log`);
      }
    }
    if (tombstoneId) {
      send({
        type: 'tombstone',
        event: {
          tweet_id: tombstoneId,
          entry_id: `tweet-${tombstoneId}`,
          typename: 'TweetTombstone',
          text: 'This Post was deleted by the Post author.',
          source_op: 'fake-extension',
          captured_at_ms: Date.now(),
        },
      });
      console.log(`sent tombstone for ${tombstoneId}`);
    }
    setTimeout(() => ws.close(), 1500);
  } else if (frame.type === 'status') {
    console.log('app status:', frame);
  } else if (frame.type === 'error') {
    console.error('app error:', frame);
    process.exit(1);
  }
});

ws.on('close', () => {
  console.log('done.');
  process.exit(0);
});
ws.on('error', (error) => {
  console.error(`cannot reach the app on ${host}:${port} — is it running?`, error.message);
  process.exit(1);
});

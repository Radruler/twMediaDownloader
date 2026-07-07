/**
 * End-to-end M1 protocol loop (plan 06 §2/§7): the REAL app server and the
 * REAL extension client talking over a real WebSocket on 127.0.0.1 —
 * no Chrome needed. This is the scripted stand-in for the live browser
 * walkthrough (documented for the owner in the step-3b5 handoff).
 */
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb } from '../app/src/db.js';
import { createAppServer, sanitizeTemplateHeaders } from '../app/src/server.js';
import { createAppClient } from '../extension/content/app-client.js';

const TOKEN = 'test-token-123';

function record(id: string, overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: id,
    created_at_ms: 1751630591000,
    lang: 'en',
    user: { id_str: '9', screen_name: 'someone', name: 'Some One' },
    full_text: `tweet ${id}`,
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: id,
    edit_initial_id_str: id,
    counts: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [],
    source_op: 'HomeTimeline',
    captured_at_ms: Date.now(),
    ...overrides,
  };
}

type Cleanup = () => Promise<void> | void;
const cleanups: Cleanup[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(extra: Record<string, unknown> = {}) {
  const db = openDb();
  const server = createAppServer({ port: 0, token: TOKEN, db, ...extra });
  await server.ready;
  cleanups.push(async () => {
    await server.close();
    db.close();
  });
  return { db, server };
}

function startClient(port: number, options: Record<string, unknown> = {}) {
  const client = createAppClient({
    token: TOKEN,
    port,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    backoffBaseMs: 30, // fast reconnects for tests
    ...options,
  });
  cleanups.push(() => client.stop());
  client.start();
  return client;
}

async function until(predicate: () => boolean, ms = 3000) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: ms, interval: 10 });
}

describe('M1 protocol loop (real ws, real db)', () => {
  it('pairs, ingests seen frames, and reports status', async () => {
    const { db, server } = await startServer();
    const client = startClient(server.port);
    await until(() => client.state.connected);

    client.sendSeen(record('1'));
    client.sendSeen(record('2'));
    client.sendSeen(record('2')); // duplicate — upsert, not a new row
    await until(() => server.counters.seen === 3);
    expect(db.stats().posts).toBe(2);
    expect(client.state.lastStatus).toMatchObject({ type: 'status' });
  });

  it('archive frames move posts to queued and reach the downloader hook', async () => {
    const archived: unknown[] = [];
    const { db, server } = await startServer({ onArchive: (r: unknown) => archived.push(r) });
    const client = startClient(server.port);
    await until(() => client.state.connected);

    client.sendArchive(record('7'), 'button');
    await until(() => archived.length === 1);
    expect(db.getPost('7').state).toBe('queued');
    expect(archived[0]).toMatchObject({ post_key: '7', reason: 'button' });
  });

  it('tombstones flag known posts as deleted', async () => {
    const { db, server } = await startServer();
    const client = startClient(server.port);
    await until(() => client.state.connected);

    client.sendSeen(record('55'));
    await until(() => server.counters.seen === 1);
    client.sendTombstone({
      tweet_id: '55',
      entry_id: 'tweet-55',
      typename: 'TweetTombstone',
      text: 'This Post was deleted by the Post author.',
      source_op: 'TweetDetail',
      captured_at_ms: Date.now(),
    });
    await until(() => server.counters.tombstone === 1);
    expect(db.getPost('55').deleted).toBe(1);
  });

  it('rejects a bad token and the client stops retrying (fatal)', async () => {
    const { server } = await startServer();
    const client = createAppClient({
      token: 'WRONG',
      port: server.port,
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
      backoffBaseMs: 30,
    });
    cleanups.push(() => client.stop());
    client.start();
    await until(() => client.state.fatal === 'bad_token');
    expect(client.state.connected).toBe(false);
  });

  it('requires hello before anything else', async () => {
    const { db, server } = await startServer();
    const raw = new WebSocket(`ws://127.0.0.1:${server.port}`);
    cleanups.push(() => raw.close());
    const closed = new Promise<number>((resolve) => raw.on('close', (code: number) => resolve(code)));
    raw.on('open', () => raw.send(JSON.stringify({ v: 1, type: 'seen', record: record('9') })));
    expect(await closed).toBe(4003);
    expect(db.stats().posts).toBe(0);
  });

  it('buffers archive frames while the app is down and replays on reconnect', async () => {
    const db = openDb();
    const server1 = createAppServer({ port: 0, token: TOKEN, db });
    await server1.ready;
    const port = server1.port;
    const client = startClient(port);
    await until(() => client.state.connected);

    // kill the app mid-session — extension stays functional standalone
    await server1.close();
    await until(() => !client.state.connected);

    client.sendArchive(record('11'), 'button');
    client.sendArchive(record('12'), 'bulk', 'run-1');
    expect(client.archiveBufferSize()).toBe(2);

    // app restarts on the same port + same library → buffered archives replay
    const server2 = createAppServer({ port, token: TOKEN, db });
    await server2.ready;
    cleanups.push(async () => {
      await server2.close();
      db.close();
    });
    await until(() => client.state.connected && client.archiveBufferSize() === 0, 5000);
    await until(() => server2.counters.archive === 2);
    expect(db.getPost('11').state).toBe('queued');
    expect(db.getPost('12').state).toBe('queued');
  });

  it('caps the offline archive buffer at 200, dropping oldest', () => {
    const client = createAppClient({ token: TOKEN, WebSocketImpl: null });
    for (let i = 0; i < 205; i += 1) client.sendArchive(record(String(i)), 'button');
    expect(client.archiveBufferSize()).toBe(200);
    expect(client.state.dropped.archive).toBe(5);
  });
});

describe('sanitizeTemplateHeaders', () => {
  it('drops cookies and auth-like headers, keeps browser-shape headers', () => {
    expect(
      sanitizeTemplateHeaders({
        'User-Agent': 'Mozilla/5.0',
        Accept: 'image/avif,image/webp,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://x.com/',
        Cookie: 'auth_token=SECRET',
        'Set-Cookie': 'x=y',
        Authorization: 'Bearer SECRET',
        'X-Csrf-Token': 'SECRET',
        'sec-ch-ua': '"Chromium";v="126"',
      }),
    ).toEqual({
      'User-Agent': 'Mozilla/5.0',
      Accept: 'image/avif,image/webp,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://x.com/',
      'sec-ch-ua': '"Chromium";v="126"',
    });
  });
});

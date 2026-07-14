import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { toArchivistPost } from '@twmd/core';
import { openDb } from '../archivist/src/db.js';
import { createArchivistServer } from '../archivist/src/server.js';

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(): TweetRecord {
  return {
    id_str: '200',
    created_at_ms: Date.UTC(2026, 6, 4),
    lang: 'en',
    user: { id_str: '99', screen_name: 'api_artist', name: 'API Artist' },
    full_text: 'api post',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    in_reply_to_user_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: '200',
    edit_initial_id_str: '200',
    viewer: { liked: null, bookmarked: null },
    counts: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [
      {
        type: 'photo',
        media_key: '3_200',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/API.jpg',
        alt_text: null,
        video_variants: [],
        width: 20,
        height: 20,
        duration_ms: null,
        tagged_users: [],
      },
    ],
    source_op: 'TweetDetail',
    captured_at_ms: Date.now(),
  };
}

const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), 'archivist-server-'));
  tempDirs.push(dir);
  const library = openDb(path.join(dir, 'library.sqlite3'));
  const server = createArchivistServer({
    library,
    config: {
      api_token: 'secret',
      archive_root: path.join(dir, 'archive'),
      bind_host: '127.0.0.1',
      port: 0,
    },
    host: '127.0.0.1',
    port: 0,
  } as any);
  await server.ready;
  cleanups.push(async () => {
    await server.close();
    library.close();
  });
  return { library, base: `http://127.0.0.1:${server.port}` };
}

describe('Archivist HTTP API', () => {
  it('requires auth for API routes and exposes stats', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/stats`)).status).toBe(401);
    const response = await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer secret' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ posts: 0, media: 0, files: 0 });
  });

  it('supports push ingest post/file/repost flow', async () => {
    const { base, library } = await start();
    const bytes = Buffer.from('api image bytes');
    const hash = sha256(bytes);
    const envelope = toArchivistPost(record(), [{ media_key: '3_200', sha256: hash, path: 'api_artist/file.jpg' }], []);
    const headers = { authorization: 'Bearer secret' };

    let response = await fetch(`${base}/api/ingest/post`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(await response.json()).toMatchObject({ ok: true, missing_files: [hash] });

    response = await fetch(`${base}/api/ingest/file/${hash}`, { method: 'PUT', headers, body: bytes });
    expect(response.status).toBe(200);

    response = await fetch(`${base}/api/ingest/post`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    expect(await response.json()).toMatchObject({ ok: true, missing_files: [] });
    expect(library.stats()).toMatchObject({ posts: 1, files: 1, media: 1 });

    response = await fetch(`${base}/files/${hash}?token=secret`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('api image bytes');
  });

  it('round-trips curation writes and refuses captured-service relation writes', async () => {
    const { base } = await start();
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const envelope = toArchivistPost(record(), [], []);
    await fetch(`${base}/api/ingest/post`, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope),
    });
    const post = await fetch(`${base}/api/posts?token=secret`).then((r) => r.json()).then((b) => b.items[0]);

    let response = await fetch(`${base}/api/items/post/${post.id}/tags`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ names: ['keepers'] }),
    });
    expect(await response.json()).toEqual({ tags: ['keepers'] });

    response = await fetch(`${base}/api/items/post/${post.id}/relations/archivist/favorite`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: true }),
    });
    expect(response.status).toBe(200);

    response = await fetch(`${base}/api/items/post/${post.id}/relations/twitter/like`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: true }),
    });
    expect(response.status).toBe(400);

    response = await fetch(`${base}/api/items/post/${post.id}/credits`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        credits: [{ new_account: { service: 'twitter', screen_name: 'credited_person' }, role: 'subject' }],
      }),
    });
    const credits = await response.json();
    expect(credits.credits[0]).toMatchObject({ role: 'subject', item_kind: 'post', item_id: post.id });
  });
});

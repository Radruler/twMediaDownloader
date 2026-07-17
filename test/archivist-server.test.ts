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

    // The staged upload was relocated into the Decision-4 tree with mime.
    const fileRow = library.raw.prepare('SELECT * FROM files WHERE sha256 = ?').get(hash);
    expect(fileRow).toMatchObject({ relpath: path.join('twitter', 'api_artist', 'file.jpg'), mime: 'image/jpeg' });

    response = await fetch(`${base}/files/${hash}?token=secret`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('api image bytes');

    // Range serving (video seeking).
    response = await fetch(`${base}/files/${hash}?token=secret`, { headers: { range: 'bytes=4-8' } });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('image');
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
    expect(response.status).toBe(403);

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

  it('applies documented post and work filters through the HTTP API', async () => {
    const { base } = await start();
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const envelope = (
      key: string,
      text: string,
      mediaType: string,
      author: { id: string; screen: string },
      replyTo: string | null = null,
      overrides: Record<string, unknown> = {},
    ) => ({
      v: 1,
      service: 'twitter',
      post_key: key,
      author: { service_account_id: author.id, screen_name: author.screen, display_name: author.screen, status: 'unknown' },
      created_at_ms: Number(key),
      text,
      lang: 'en',
      url: null,
      is_sensitive: false,
      deleted: false,
      counts: {},
      reply_to: { key: replyTo, author_service_account_id: replyTo ? author.id : null },
      quoted_key: null,
      versions: [{ service_version_id: key, captured_at_ms: Number(key), raw: { full_text: text, mentions: [] } }],
      media: [{ position: 1, type: mediaType, sha256: null, source_url: null, alt_text: `altword${key}`, width: 1, height: 1, duration_ms: null }],
      relations: [],
      ...overrides,
    });
    const ingest = (body: unknown) =>
      fetch(`${base}/api/ingest/post`, { method: 'POST', headers, body: JSON.stringify(body) });

    await ingest(envelope('10', 'alpha needle', 'photo', { id: 'a1', screen: 'artist_one' }));
    await ingest(envelope('11', 'beta haystack', 'video', { id: 'a2', screen: 'artist_two' }));
    await ingest(envelope('12', 'thread child marker', 'photo', { id: 'a1', screen: 'artist_one' }, '10'));
    await ingest(envelope('13', 'deleted root', 'photo', { id: 'a3', screen: 'artist_three' }, null, { deleted: true }));
    await ingest(envelope('14', 'live child of deleted root', 'photo', { id: 'a3', screen: 'artist_three' }, '13'));
    await ingest(envelope('15', 'sensitive post', 'photo', { id: 'a4', screen: 'artist_four' }, null, { is_sensitive: true }));
    await ingest(envelope('16', 'tie one', 'photo', { id: 'a5', screen: 'tie_author' }, null, { created_at_ms: 20 }));
    await ingest(envelope('17', 'tie two', 'photo', { id: 'a5', screen: 'tie_author' }, null, { created_at_ms: 20 }));

    const allPosts = await fetch(`${base}/api/posts?token=secret&deleted=include`).then((r) => r.json());
    const root = allPosts.items.find((p: { service_post_key: string }) => p.service_post_key === '10');
    const child = allPosts.items.find((p: { service_post_key: string }) => p.service_post_key === '12');
    const video = allPosts.items.find((p: { service_post_key: string }) => p.service_post_key === '11');
    const deletedChild = allPosts.items.find((p: { service_post_key: string }) => p.service_post_key === '14');
    const tiePost = allPosts.items.find((p: { service_post_key: string }) => p.service_post_key === '17');

    await fetch(`${base}/api/items/post/${child.id}/tags`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ names: ['thread-filter'] }),
    });
    await fetch(`${base}/api/items/post/${video.id}/relations/archivist/favorite`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: true }),
    });
    await fetch(`${base}/api/items/post/${video.id}/relations/archivist/rating`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: true, value: '4' }),
    });
    const creditResponse = await fetch(`${base}/api/items/media/${video.media[0].id}/credits`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credits: [{ new_account: { service: 'twitter', screen_name: 'featured' }, role: 'subject' }] }),
    }).then((r) => r.json());
    const creditedId = creditResponse.credits[0].account.id;
    const persona = await fetch(`${base}/api/personas`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Persona One' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/personas/${persona.id}/accounts/${root.author.id}`, { method: 'PUT', headers });
    const creditedPersona = await fetch(`${base}/api/personas`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Featured Persona' }),
    }).then((r) => r.json());
    await fetch(`${base}/api/personas/${creditedPersona.id}/accounts/${creditedId}`, { method: 'PUT', headers });

    const byAuthor = await fetch(`${base}/api/posts?token=secret&author=${root.author.id}`).then((r) => r.json());
    expect(byAuthor.items.map((p: { service_post_key: string }) => p.service_post_key).sort()).toEqual(['10', '12']);

    const byPersona = await fetch(`${base}/api/posts?token=secret&persona=${persona.id}`).then((r) => r.json());
    expect(byPersona.items.map((p: { service_post_key: string }) => p.service_post_key).sort()).toEqual(['10', '12']);

    const byText = await fetch(`${base}/api/posts?token=secret&q=needle`).then((r) => r.json());
    expect(byText.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['10']);

    const byAltText = await fetch(`${base}/api/posts?token=secret&q=altword10`).then((r) => r.json());
    expect(byAltText.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['10']);

    const byAuthorName = await fetch(`${base}/api/posts?token=secret&q=artist_one`).then((r) => r.json());
    expect(byAuthorName.items.map((p: { service_post_key: string }) => p.service_post_key).sort()).toEqual(['10', '12']);

    const byType = await fetch(`${base}/api/posts?token=secret&type=video`).then((r) => r.json());
    expect(byType.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['11']);

    const byMediaPresence = await fetch(`${base}/api/posts?token=secret&has_media=1`).then((r) => r.json());
    expect(byMediaPresence.items.length).toBeGreaterThanOrEqual(7);

    const byFavoriteRating = await fetch(`${base}/api/posts?token=secret&favorite=1&rating_min=3`).then((r) => r.json());
    expect(byFavoriteRating.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['11']);

    const byFavoriteRelation = await fetch(`${base}/api/posts?token=secret&relation=archivist:favorite`).then((r) => r.json());
    expect(byFavoriteRelation.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['11']);

    const byRatingRelation = await fetch(`${base}/api/posts?token=secret&relation=archivist:rating:4`).then((r) => r.json());
    expect(byRatingRelation.items.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['11']);

    const withoutSensitive = await fetch(`${base}/api/posts?token=secret&sensitive=exclude`).then((r) => r.json());
    expect(withoutSensitive.items.some((p: { service_post_key: string }) => p.service_post_key === '15')).toBe(false);

    const worksByChildTag = await fetch(`${base}/api/works?token=secret&tag=thread-filter`).then((r) => r.json());
    expect(worksByChildTag.items).toHaveLength(1);
    expect(worksByChildTag.items[0].parts.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['10', '12']);

    const worksByMediaCredit = await fetch(`${base}/api/works?token=secret&credited=${creditedId}&role=subject`).then((r) => r.json());
    expect(worksByMediaCredit.items.map((w: { thread_key: string }) => w.thread_key)).toEqual(['11']);

    const worksByCreditedPersona = await fetch(`${base}/api/works?token=secret&credited_persona=${creditedPersona.id}&role=subject`).then((r) => r.json());
    expect(worksByCreditedPersona.items.map((w: { thread_key: string }) => w.thread_key)).toEqual(['11']);

    await fetch(`${base}/api/items/post/${deletedChild.id}/tags`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ names: ['deleted-thread-live-child'] }),
    });
    const worksWithDeletedRoot = await fetch(`${base}/api/works?token=secret&tag=deleted-thread-live-child`).then((r) => r.json());
    expect(worksWithDeletedRoot.items).toHaveLength(1);
    expect(worksWithDeletedRoot.items[0].parts.map((p: { service_post_key: string; deleted: boolean }) => [p.service_post_key, p.deleted])).toEqual([
      ['13', true],
      ['14', false],
    ]);

    const createdTiePage1 = await fetch(`${base}/api/posts?token=secret&limit=1&author=${encodeURIComponent(String(tiePost.author.id))}`).then((r) => r.json());
    expect(createdTiePage1.items).toHaveLength(1);
    expect(createdTiePage1.next_cursor).toBeTruthy();
    const createdTiePage2 = await fetch(`${base}/api/posts?token=secret&limit=1&cursor=${encodeURIComponent(createdTiePage1.next_cursor)}&author=${encodeURIComponent(String(tiePost.author.id))}`).then((r) => r.json());
    expect(createdTiePage2.items).toHaveLength(1);
    expect(new Set([...createdTiePage1.items, ...createdTiePage2.items].map((p: { service_post_key: string }) => p.service_post_key))).toEqual(new Set(['16', '17']));

    const tiedPage1 = await fetch(`${base}/api/posts?token=secret&limit=1&author=${encodeURIComponent(String(root.author.id))}&sort=ingested`).then((r) => r.json());
    expect(tiedPage1.items).toHaveLength(1);
    expect(tiedPage1.next_cursor).toBeTruthy();
    const tiedPage2 = await fetch(`${base}/api/posts?token=secret&limit=1&cursor=${encodeURIComponent(tiedPage1.next_cursor)}&author=${encodeURIComponent(String(root.author.id))}&sort=ingested`).then((r) => r.json());
    expect(tiedPage2.items).toHaveLength(1);
    expect(new Set([...tiedPage1.items, ...tiedPage2.items].map((p: { service_post_key: string }) => p.service_post_key))).toEqual(new Set(['10', '12']));

    const badFts = await fetch(`${base}/api/posts?token=secret&q=${encodeURIComponent('"')}`);
    expect(badFts.status).toBe(400);
  });

  it('lists works with deterministic roots, missing-part honesty, and cursor pagination', async () => {
    const { base } = await start();
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const envelope = (key: string, createdAt: number, replyTo: string | null = null) => ({
      v: 1,
      service: 'twitter',
      post_key: key,
      author: { service_account_id: '9', screen_name: 'threader', display_name: 'Threader', status: 'unknown' },
      created_at_ms: createdAt,
      text: `post ${key}`,
      lang: 'en',
      url: null,
      is_sensitive: false,
      deleted: false,
      counts: {},
      reply_to: { key: replyTo, author_service_account_id: replyTo ? '9' : null },
      quoted_key: null,
      versions: [{ service_version_id: key, captured_at_ms: createdAt, raw: {} }],
      media: [],
      relations: [],
    });
    const post = (body: unknown) =>
      fetch(`${base}/api/ingest/post`, { method: 'POST', headers, body: JSON.stringify(body) });

    // Child arrives first; its parent A is not archived yet → missing part.
    await post(envelope('B', 2, 'A'));
    let works = await fetch(`${base}/api/works?token=secret`).then((r) => r.json());
    expect(works.items).toHaveLength(1);
    expect(works.items[0]).toMatchObject({ thread_key: 'A', missing_parts: 1 });

    // Parent arrives → one work, two parts, root is the earliest part, honest again.
    await post(envelope('A', 1));
    works = await fetch(`${base}/api/works?token=secret`).then((r) => r.json());
    expect(works.items).toHaveLength(1);
    expect(works.items[0].parts.map((p: { service_post_key: string }) => p.service_post_key)).toEqual(['A', 'B']);
    expect(works.items[0].missing_parts).toBe(0);

    // Two more standalone posts → cursor pagination walks everything once.
    await post(envelope('C', 3));
    await post(envelope('D', 4));
    const page1 = await fetch(`${base}/api/works?limit=2&token=secret`).then((r) => r.json());
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await fetch(`${base}/api/works?limit=2&cursor=${page1.next_cursor}&token=secret`).then((r) => r.json());
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((w: { thread_key: string }) => w.thread_key);
    expect(new Set(seen).size).toBe(3);
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb as openClientDb } from '../app/src/db.js';
import { createArchivistPusher } from '../app/src/pusher.js';
import { openDb as openArchivistDb } from '../archivist/src/db.js';
import { createArchivistServer } from '../archivist/src/server.js';

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function record(): TweetRecord {
  return {
    id_str: 'push-1',
    created_at_ms: Date.UTC(2026, 6, 4, 21, 3, 11),
    lang: 'en',
    user: { id_str: '9', screen_name: 'push_artist', name: 'Push Artist' },
    full_text: 'push me',
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    in_reply_to_user_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: 'push-1',
    edit_initial_id_str: 'push-1',
    viewer: { liked: true, bookmarked: null },
    counts: { replies: 0, retweets: 0, likes: 1, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [
      {
        type: 'photo',
        media_key: '3_push',
        index: 1,
        image_url: 'https://pbs.twimg.com/media/PUSH.jpg',
        alt_text: null,
        video_variants: [],
        width: 10,
        height: 10,
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

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-pusher-'));
  tempDirs.push(dir);
  return dir;
}

describe('Archivist Client pusher', () => {
  it('pushes dirty archived posts through the real Archivist ingest API and acks them', async () => {
    const clientDir = tempDir();
    const archivistDir = tempDir();
    const bytes = Buffer.from('push image');
    const hash = sha256(bytes);
    const mediaPath = path.join(clientDir, 'archive', 'push_artist', 'push.jpg');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(mediaPath), { recursive: true }));
    writeFileSync(mediaPath, bytes);

    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    client.ingestSeen(record());
    client.recordFile({ media_key: '3_push', path: mediaPath, bytes: bytes.length, sha256: hash });
    client.setPostState('push-1', 'archived');
    expect(client.exportStats()).toMatchObject({ dirty: 1, acked: 0 });

    const archivist = openArchivistDb(path.join(archivistDir, 'library.sqlite3'));
    const server = createArchivistServer({
      library: archivist,
      config: {
        api_token: 'secret',
        archive_root: path.join(archivistDir, 'archive'),
        bind_host: '127.0.0.1',
        port: 0,
      },
      host: '127.0.0.1',
      port: 0,
    } as any);
    await server.ready;
    cleanups.push(async () => {
      await server.close();
      archivist.close();
      client.close();
    });

    const pusher = createArchivistPusher({
      db: client,
      config: {
        archivist_url: `http://127.0.0.1:${server.port}`,
        archivist_token: 'secret',
        own_accounts: [{ service_account_id: 'owner', screen_name: 'owner' }],
      },
      autoStart: false,
    });
    await expect(pusher.sweep()).resolves.toEqual({ pushed: 1, skipped: 0 });
    expect(client.exportStats()).toMatchObject({ dirty: 0, acked: 1 });
    expect(archivist.stats()).toMatchObject({ posts: 1, files: 1, relations: 1 });
  });

  it('skips a 4xx poison post and still pushes the rest of the queue', async () => {
    const clientDir = tempDir();
    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    const mkRecord = (id: string, capturedAt: number) => ({ ...record(), id_str: id, edit_initial_id_str: id, conversation_id_str: id, media: [], captured_at_ms: capturedAt });
    // 'a-poison' sorts first on the (dirty_since, post_key) queue order, so it
    // is the head-of-line post that must not block 'b-good'.
    client.ingestSeen(mkRecord('a-poison', 1));
    client.setPostState('a-poison', 'archived');
    client.ingestSeen(mkRecord('b-good', 2));
    client.setPostState('b-good', 'archived');
    cleanups.push(async () => client.close());

    const calls: string[] = [];
    const fetchImpl = async (_url: string, opts: { body: string }) => {
      const envelope = JSON.parse(opts.body);
      calls.push(envelope.post_key);
      if (envelope.post_key === 'a-poison') return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, post_id: 1, missing_files: [] }) };
    };
    const pusher = createArchivistPusher({
      db: client,
      config: { archivist_url: 'http://nas.test:8470', archivist_token: 't', own_accounts: [] },
      fetchImpl: fetchImpl as any,
      autoStart: false,
    });

    await expect(pusher.sweep()).resolves.toEqual({ pushed: 1, skipped: 1 });
    expect(client.exportStats()).toMatchObject({ dirty: 1, acked: 1 });

    // Second sweep: the poisoned post is not retried this process lifetime.
    await expect(pusher.sweep()).resolves.toEqual({ pushed: 0, skipped: 1 });
    expect(calls.filter((k) => k === 'a-poison')).toHaveLength(1);
  });

  it('abandons the sweep on network failure without acking anything', async () => {
    const clientDir = tempDir();
    const client = openClientDb(path.join(clientDir, 'library.sqlite3'));
    client.ingestSeen({ ...record(), media: [] });
    client.setPostState('push-1', 'archived');
    cleanups.push(async () => client.close());

    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new TypeError('fetch failed'); // NAS asleep — the normal case
    };
    const pusher = createArchivistPusher({
      db: client,
      config: { archivist_url: 'http://nas.test:8470', archivist_token: 't', own_accounts: [] },
      fetchImpl: fetchImpl as any,
      autoStart: false,
    });

    await expect(pusher.sweep()).resolves.toEqual({ pushed: 0, skipped: 1 });
    expect(client.exportStats()).toMatchObject({ dirty: 1, acked: 0 });
    expect(attempts).toBe(1);

    // Not poisoned: the next sweep (the timer's retry) tries again.
    await pusher.sweep();
    expect(attempts).toBe(2);
  });
});

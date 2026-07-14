/**
 * M2 downloader + disk writer (plan 06 §4): injectable fetch, real files
 * in a temp dir, real in-memory SQLite. Proves archiving end-to-end
 * without any network.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaRecord, TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb } from '../app/src/db.js';
import { createDiskWriter, archiveDirFor, sha256Hex } from '../app/src/disk-writer.js';
import { createDownloader, isAllowedCdnUrl } from '../app/src/downloader.js';

function localEpoch(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
const CREATED = localEpoch(2026, 7, 4, 21, 3, 11);
const TS = '20260704_210311';

function photo(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    type: 'photo',
    media_key: '3_1',
    index: 1,
    image_url: 'https://pbs.twimg.com/media/AAA.jpg',
    alt_text: null,
    video_variants: [],
    width: 100,
    height: 100,
    duration_ms: null,
    tagged_users: [],
    ...overrides,
  };
}

function record(id: string, overrides: Partial<TweetRecord> = {}): TweetRecord {
  return {
    id_str: id,
    created_at_ms: CREATED,
    lang: 'en',
    user: { id_str: '9', screen_name: 'someone', name: 'Some One' },
    full_text: `tweet ${id}`,
    urls: [],
    hashtags: [],
    mentions: [],
    in_reply_to_status_id_str: null,
    in_reply_to_user_id_str: null,
    quoted_status_id_str: null,
    retweeted_status_id_str: null,
    conversation_id_str: id,
    edit_initial_id_str: id,
    viewer: { liked: null, bookmarked: null },
    counts: { replies: 0, retweets: 0, likes: 0, quotes: 0, bookmarks: 0, views: null },
    is_sensitive: false,
    media: [photo()],
    source_op: 'UserMedia',
    captured_at_ms: Date.now(),
    ...overrides,
  };
}

type FakeCall = { url: string; headers: Record<string, string> };

function fakeFetch(
  handler: (url: string, attempt: number) => { status: number; body?: Uint8Array },
) {
  const calls: FakeCall[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ url, headers: init.headers });
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    const result = handler(url, attempt);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      arrayBuffer: async () => (result.body ?? new Uint8Array()).buffer,
    };
  };
  return { impl, calls, maxInFlight: () => maxInFlight };
}

const BYTES = new TextEncoder().encode('fake image bytes');

let tempDirs: string[] = [];
let dbs: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  for (const db of dbs) db.close();
  dbs = [];
});

function setup(fetch: ReturnType<typeof fakeFetch>, options: Record<string, unknown> = {}) {
  const archiveRoot = mkdtempSync(path.join(tmpdir(), 'twmd-archive-'));
  tempDirs.push(archiveRoot);
  const db = openDb();
  dbs.push(db);
  const writer = createDiskWriter({ db, archiveRoot });
  const downloader = createDownloader({
    db,
    writer,
    fetchImpl: fetch.impl as unknown as typeof globalThis.fetch,
    gapMs: () => 1,
    retryBaseMs: 1,
    getTemplate: () => ({
      headers: {
        'User-Agent': 'Mozilla/5.0 test',
        Cookie: 'MUST-NEVER-BE-SENT', // defense-in-depth check
      },
      observed_at: Date.now(),
    }),
    ...options,
  });
  return { archiveRoot, db, writer, downloader };
}

function enqueueRecord(
  ctx: ReturnType<typeof setup>,
  rec: TweetRecord,
  extra: Record<string, unknown> = {},
) {
  const post_key = ctx.db.ingestArchiveRequest(rec);
  ctx.downloader.enqueue({ record: rec, post_key, reason: 'button', ...extra });
  return post_key;
}

describe('downloader M2', () => {
  it('archives a photo tweet: original + sidecar on disk, files row, state archived', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    enqueueRecord(ctx, record('500'));
    await ctx.downloader.drain();

    const dir = path.join(ctx.archiveRoot, 'someone');
    const files = readdirSync(dir).sort();
    expect(files).toEqual([`someone-500-${TS}-img1.jpg`, `someone-500-${TS}.txt`]);
    expect(readFileSync(path.join(dir, files[0]))).toEqual(Buffer.from(BYTES));
    const sidecar = readFileSync(path.join(dir, files[1]), 'utf8');
    expect(sidecar).toContain('https://x.com/someone/status/500');
    expect(sidecar).toContain('1. photo https://pbs.twimg.com/media/AAA?format=jpg&name=orig');
    expect(ctx.db.getPost('500').state).toBe('archived');
    expect(ctx.db.findFileBySha(sha256Hex(Buffer.from(BYTES)))).not.toBeNull();
    // orig URL was requested, template UA forwarded, cookie never sent
    expect(fetch.calls[0].url).toBe('https://pbs.twimg.com/media/AAA?format=jpg&name=orig');
    expect(fetch.calls[0].headers['User-Agent']).toBe('Mozilla/5.0 test');
    expect(Object.keys(fetch.calls[0].headers).join()).not.toMatch(/cookie/i);
  });

  it('dedupes identical bytes across posts (sha256 UNIQUE)', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    enqueueRecord(ctx, record('1'));
    await ctx.downloader.drain();
    enqueueRecord(ctx, record('2', { media: [photo({ media_key: '3_2' })] }));
    await ctx.downloader.drain();

    const dir = path.join(ctx.archiveRoot, 'someone');
    const mediaFiles = readdirSync(dir).filter((f) => f.endsWith('.jpg'));
    expect(mediaFiles).toHaveLength(1); // second archive wrote NO new media file
    expect(ctx.db.getPost('2').state).toBe('archived'); // but still counts as archived
    expect(ctx.db.stats().files).toBe(1);
  });

  it('walks the photo fallback chain on 404 and flags all-gone posts deleted', async () => {
    const gone = fakeFetch(() => ({ status: 404 }));
    const ctx = setup(gone);
    enqueueRecord(ctx, record('404tweet'));
    await ctx.downloader.drain();

    expect(gone.calls.map((c) => c.url)).toEqual([
      'https://pbs.twimg.com/media/AAA?format=jpg&name=orig',
      'https://pbs.twimg.com/media/AAA?format=jpg&name=4096x4096',
      'https://pbs.twimg.com/media/AAA?format=jpg&name=large',
    ]);
    const post = ctx.db.getPost('404tweet');
    expect(post.state).toBe('archive_failed');
    expect(post.deleted).toBe(1);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    const flaky = fakeFetch((url, attempt) =>
      attempt < 3 ? { status: 503 } : { status: 200, body: BYTES },
    );
    const ctx = setup(flaky);
    enqueueRecord(ctx, record('7'));
    await ctx.downloader.drain();
    expect(ctx.db.getPost('7').state).toBe('archived');
    expect(flaky.calls).toHaveLength(3);
  });

  it('gives up after retries are exhausted → archive_failed', async () => {
    const dead = fakeFetch(() => ({ status: 500 }));
    const ctx = setup(dead);
    enqueueRecord(ctx, record('8'));
    await ctx.downloader.drain();
    expect(ctx.db.getPost('8').state).toBe('archive_failed');
    expect(dead.calls).toHaveLength(4); // 1 + 3 retries, no fallback hammering
    const dir = path.join(ctx.archiveRoot, 'someone');
    expect(existsSync(dir)).toBe(false); // nothing saved, no sidecar
  });

  it('routes bulk-run archives to _runs/<date>-<label>/ (Decision 13)', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    ctx.downloader.setRun('run-1', 'begin', 'my likes!');
    enqueueRecord(ctx, record('9'), { run_id: 'run-1' });
    await ctx.downloader.drain();

    const runsDir = path.join(ctx.archiveRoot, '_runs');
    const runFolders = readdirSync(runsDir);
    expect(runFolders).toHaveLength(1);
    expect(runFolders[0]).toMatch(/^\d{8}-my likes!$/);
    const files = readdirSync(path.join(runsDir, runFolders[0])).sort();
    expect(files).toEqual([`someone-9-${TS}-img1.jpg`, `someone-9-${TS}.txt`]);
  });

  it('refuses any non-CDN host outright (hard constraint)', async () => {
    expect(isAllowedCdnUrl('https://pbs.twimg.com/media/A.jpg')).toBe(true);
    expect(isAllowedCdnUrl('https://video.twimg.com/v.mp4')).toBe(true);
    expect(isAllowedCdnUrl('https://x.com/anything')).toBe(false);
    expect(isAllowedCdnUrl('https://api.x.com/graphql')).toBe(false);
    expect(isAllowedCdnUrl('https://evil.example.com/a.jpg')).toBe(false);

    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    enqueueRecord(
      ctx,
      record('evil', { media: [photo({ image_url: 'https://evil.example.com/a.jpg' })] }),
    );
    await ctx.downloader.drain();
    expect(fetch.calls).toHaveLength(0); // never even attempted
    expect(ctx.db.getPost('evil').state).toBe('archive_failed');
  });

  it('never runs more than 2 requests concurrently', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    for (let i = 0; i < 6; i += 1) enqueueRecord(ctx, record(`c${i}`));
    await ctx.downloader.drain();
    expect(fetch.maxInFlight()).toBeLessThanOrEqual(2);
    expect(fetch.calls).toHaveLength(6);
  });

  it('a media-less tweet still gets its sidecar and archives', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: BYTES }));
    const ctx = setup(fetch);
    enqueueRecord(ctx, record('textonly', { media: [] }));
    await ctx.downloader.drain();
    expect(fetch.calls).toHaveLength(0);
    const dir = path.join(ctx.archiveRoot, 'someone');
    expect(readdirSync(dir)).toEqual([`someone-textonly-${TS}.txt`]);
    expect(ctx.db.getPost('textonly').state).toBe('archived');
  });
});

describe('archiveDirFor', () => {
  it('sanitizes hostile screen names and run labels', () => {
    const rec = record('1', { user: { id_str: '9', screen_name: '../evil', name: null } });
    expect(archiveDirFor('/root', rec)).toBe('/root/.._evil');
    expect(archiveDirFor('/root', rec, { label: 'a/b\\c', started_at: CREATED })).toBe(
      `/root/_runs/20260704-a_b_c`,
    );
  });
});

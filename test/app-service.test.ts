import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaRecord, TweetRecord } from '../packages/core/src/tweet-record.ts';
import { openDb } from '../app/src/db.js';
import { startApp } from '../app/src/main.js';
import { runCli } from '../app/src/cli.js';

const CREATED = new Date(2026, 6, 4, 21, 3, 11).getTime();
const BYTES = new TextEncoder().encode('service image bytes');

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

function fakeFetch(status = 200) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => BYTES.buffer,
    };
  };
  return { calls, impl: impl as unknown as typeof globalThis.fetch };
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function makeConfigDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'twmd-app-'));
  tempDirs.push(dir);
  const archiveRoot = path.join(dir, 'archive');
  const dbPath = path.join(dir, 'library.sqlite3');
  writeFileSync(
    path.join(dir, 'config.json'),
    `${JSON.stringify(
      {
        bind_host: '127.0.0.1',
        port: 0,
        token: 'test-token',
        archive_root: archiveRoot,
        db_path: dbPath,
        log_level: 'quiet',
      },
      null,
      2,
    )}\n`,
  );
  return { dir, archiveRoot, dbPath };
}

describe('content-manager service startup', () => {
  it('resumes persisted queued posts from a file-backed DB on restart', async () => {
    const cfg = makeConfigDir();
    const db = openDb(cfg.dbPath);
    db.ingestArchiveRequest(record('restart'));
    db.close();

    const fetch = fakeFetch();
    const app = await startApp({
      dir: cfg.dir,
      fetchImpl: fetch.impl,
      gapMs: () => 1,
      retryBaseMs: 1,
      registerSignals: false,
      exitOnShutdown: false,
    });
    await app.downloader.drain();

    expect(app.db.getPost('restart').state).toBe('archived');
    expect(fetch.calls).toEqual(['https://pbs.twimg.com/media/AAA?format=jpg&name=orig']);
    expect(readdirSync(path.join(cfg.archiveRoot, 'someone')).sort()).toEqual([
      'someone-restart-20260704_210311-img1.jpg',
      'someone-restart-20260704_210311.txt',
    ]);
    await app.shutdown();
  });
});

describe('operator CLI', () => {
  it('archives a stored library post without the browser', async () => {
    const cfg = makeConfigDir();
    const db = openDb(cfg.dbPath);
    db.ingestSeen(record('cli-archive'));
    db.close();

    const fetch = fakeFetch();
    await expect(runCli(['archive', 'cli-archive'], { dir: cfg.dir, fetchImpl: fetch.impl })).resolves.toBe(0);

    const reopened = openDb(cfg.dbPath);
    expect(reopened.getPost('cli-archive').state).toBe('archived');
    reopened.close();
    expect(fetch.calls).toHaveLength(1);
  });

  it('requeues failed posts only through the explicit CLI path', async () => {
    const cfg = makeConfigDir();
    const db = openDb(cfg.dbPath);
    db.ingestArchiveRequest(record('failed'));
    db.setPostState('failed', 'archive_failed');
    db.close();

    const fetch = fakeFetch();
    await expect(runCli(['requeue', '--all-failed'], { dir: cfg.dir, fetchImpl: fetch.impl })).resolves.toBe(0);

    const reopened = openDb(cfg.dbPath);
    expect(reopened.getPost('failed').state).toBe('archived');
    reopened.close();
  });

  it('purges with dry-run default and requires --yes for deletion', async () => {
    const cfg = makeConfigDir();
    const db = openDb(cfg.dbPath);
    db.ingestSeen(record('old'));
    db.close();

    await expect(runCli(['purge', '--author', 'someone'], { dir: cfg.dir })).resolves.toBe(0);
    let reopened = openDb(cfg.dbPath);
    expect(reopened.getPost('old')).toBeTruthy();
    reopened.close();

    await expect(runCli(['purge', '--author', 'someone', '--yes'], { dir: cfg.dir })).resolves.toBe(0);
    reopened = openDb(cfg.dbPath);
    expect(reopened.getPost('old')).toBeUndefined();
    reopened.close();
  });

  it('verifies recorded file hashes and reports mismatches', async () => {
    const cfg = makeConfigDir();
    const db = openDb(cfg.dbPath);
    db.ingestSeen(record('verify'));
    const mediaPath = path.join(cfg.archiveRoot, 'someone', 'file.jpg');
    await import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(path.dirname(mediaPath), { recursive: true }).then(() => writeFile(mediaPath, 'bad')),
    );
    db.recordFile({
      media_key: '3_1',
      path: mediaPath,
      bytes: 3,
      sha256: 'not-the-real-hash',
      downloaded_at: Date.now(),
    });
    db.close();

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runCli(['verify'], { dir: cfg.dir })).resolves.toBe(1);
    expect(spy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('mismatch');
    expect(existsSync(mediaPath)).toBe(true);
    expect(readFileSync(mediaPath, 'utf8')).toBe('bad');
  });
});

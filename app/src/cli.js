import { existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import minimist from 'minimist';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createDownloader } from './downloader.js';
import { createDiskWriter } from './disk-writer.js';

const STATES = new Set(['seen', 'queued', 'archived', 'archive_failed']);

function printUsage() {
  console.log(`twMediaDownloader content-manager commands

Usage:
  node app/dist/main.mjs status
  node app/dist/main.mjs requeue <post_key|--all-failed>
  node app/dist/main.mjs archive <tweet_id|post_key>
  node app/dist/main.mjs purge [--author X] [--before YYYY-MM-DD] [--state S] [--yes]
  node app/dist/main.mjs verify

Config: $TWMD_APP_DIR/config.json, with env overrides documented in README.md.`);
}

function parseBefore(value) {
  if (!value) return null;
  const time = new Date(`${value}T00:00:00`).getTime();
  if (!Number.isFinite(time)) throw new Error(`invalid --before date: ${value}`);
  return time;
}

function log(...args) {
  console.log(...args);
}

function openConfigured(dir) {
  const loaded = loadConfig(dir);
  const db = openDb(loaded.config.db_path);
  return { ...loaded, db };
}

function enqueueAndDrain(db, config, jobs, fetchImpl = globalThis.fetch) {
  const downloader = createDownloader({
    db,
    writer: createDiskWriter({ db, archiveRoot: config.archive_root }),
    log,
    fetchImpl,
    gapMs: () => 1,
    retryBaseMs: 1,
  });
  for (const job of jobs) downloader.enqueue(job);
  return downloader.drain();
}

function jobForPost(db, post_key, reason) {
  const job = db.getArchiveJob(post_key);
  return job ? { ...job, reason } : null;
}

export async function runCli(
  argv = process.argv.slice(2),
  { dir = /** @type {any} */ (undefined), fetchImpl = globalThis.fetch } = {},
) {
  const args = minimist(argv, {
    boolean: ['all-failed', 'yes', 'help'],
    string: ['author', 'before', 'state'],
    alias: { h: 'help' },
  });
  const [cmd, target] = args._;
  if (!cmd || args.help) {
    printUsage();
    return 0;
  }

  const { config, db } = openConfigured(dir);
  try {
    if (cmd === 'status') {
      const stats = db.stats();
      console.log(JSON.stringify({ ...stats, queue_depth: stats.queued, failures: db.failedPosts() }, null, 2));
      return 0;
    }

    if (cmd === 'archive') {
      if (!target) throw new Error('archive requires <tweet_id|post_key>');
      const post_key = db.postKeyForTweetId(target) ?? target;
      if (!db.getPost(post_key)) throw new Error(`post not found: ${target}`);
      db.queuePost(post_key);
      const job = jobForPost(db, post_key, 'cli-archive');
      if (!job) throw new Error(`no stored TweetRecord for ${post_key}`);
      await enqueueAndDrain(db, config, [job], fetchImpl);
      console.log(`archive complete: ${post_key} -> ${db.getPost(post_key).state}`);
      return 0;
    }

    if (cmd === 'requeue') {
      const posts = args['all-failed']
        ? db.failedPosts()
        : target
          ? [db.getPost(target)].filter(Boolean)
          : [];
      if (posts.length === 0) throw new Error('requeue requires <post_key> or --all-failed');
      const jobs = [];
      for (const post of posts) {
        if (post.state !== 'archive_failed' && post.state !== 'queued') {
          throw new Error(`cannot requeue ${post.post_key} from state ${post.state}`);
        }
        db.queuePost(post.post_key);
        const job = jobForPost(db, post.post_key, 'cli-requeue');
        if (job) jobs.push(job);
      }
      await enqueueAndDrain(db, config, jobs, fetchImpl);
      console.log(`requeue complete: ${jobs.length} post(s) processed`);
      return 0;
    }

    if (cmd === 'purge') {
      if (args.state && !STATES.has(args.state)) throw new Error(`invalid --state: ${args.state}`);
      const before = parseBefore(args.before);
      const posts = db.postsMatching({
        author: args.author ?? null,
        before,
        state: args.state ?? null,
      });
      if (!args.author && !args.before && !args.state) {
        throw new Error('purge requires at least one filter: --author, --before, or --state');
      }
      console.log(`matched ${posts.length} post(s)`);
      for (const post of posts.slice(0, 25)) {
        console.log(`${post.post_key}\t${post.author_screen_name ?? ''}\t${post.state}\t${new Date(post.last_seen_at).toISOString()}`);
      }
      if (posts.length > 25) console.log(`... ${posts.length - 25} more`);
      if (!args.yes) {
        console.log('dry run only; pass --yes to purge matched library rows and recorded files');
        return 0;
      }
      const fileRows = db.purgePosts(posts.map((post) => post.post_key));
      let deletedFiles = 0;
      for (const file of fileRows) {
        if (file.path && existsSync(file.path)) {
          unlinkSync(file.path);
          deletedFiles += 1;
        }
      }
      console.log(`purged ${posts.length} post(s), deleted ${deletedFiles} recorded media file(s)`);
      return 0;
    }

    if (cmd === 'verify') {
      await mkdir(config.archive_root, { recursive: true });
      const files = db.raw.prepare('SELECT * FROM files ORDER BY path').all();
      const { createHash } = await import('node:crypto');
      const { readFileSync } = await import('node:fs');
      const problems = [];
      for (const file of files) {
        if (!existsSync(file.path)) {
          problems.push({ path: file.path, problem: 'missing' });
          continue;
        }
        const bytes = readFileSync(file.path);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== file.sha256 || bytes.length !== file.bytes) {
          problems.push({ path: file.path, problem: 'mismatch', expected_sha256: file.sha256, actual_sha256: sha256 });
        }
      }
      console.log(JSON.stringify({ checked: files.length, problems }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }

    throw new Error(`unknown command: ${cmd}`);
  } finally {
    db.close();
  }
}

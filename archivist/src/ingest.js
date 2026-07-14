import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeForFilename } from '@twmd/core';
import { upsertAccount } from './db.js';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(value) {
  return value == null ? null : JSON.stringify(value);
}

function assertEnvelope(envelope) {
  if (!envelope || envelope.v !== 1) throw new Error('bad ArchivistPost: v must be 1');
  if (!envelope.service || !envelope.post_key) throw new Error('bad ArchivistPost: service and post_key required');
  if (!envelope.author?.service_account_id) throw new Error('bad ArchivistPost: author.service_account_id required');
  if (!Array.isArray(envelope.versions) || envelope.versions.length === 0) {
    throw new Error('bad ArchivistPost: versions required');
  }
}

function relationType(db, service, key) {
  return db.prepare('SELECT * FROM relation_types WHERE service = ? AND key = ?').get(service, key) ?? null;
}

function registeredService(db, service) {
  return !!db.prepare('SELECT 1 FROM services WHERE service = ?').get(service);
}

function deriveThreadKey(db, envelope, authorAccountId) {
  const ownKey = envelope.post_key;
  const replyKey = envelope.reply_to?.key ?? null;
  if (!replyKey || envelope.reply_to?.author_service_account_id !== envelope.author.service_account_id) return ownKey;
  const parent = db
    .prepare(
      `SELECT p.* FROM posts p
       LEFT JOIN post_versions v ON v.post_id = p.id
       WHERE p.service = ? AND (p.service_post_key = ? OR v.service_version_id = ?)
       LIMIT 1`,
    )
    .get(envelope.service, replyKey, replyKey);
  if (parent && parent.author_account_id === authorAccountId) return parent.thread_key ?? parent.service_post_key;
  return replyKey;
}

function refreshFts(db, postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  const alt = db
    .prepare('SELECT alt_text FROM media_items WHERE post_id = ? AND alt_text IS NOT NULL ORDER BY position')
    .all(postId)
    .map((r) => r.alt_text)
    .join('\n');
  const names = post.author_account_id
    ? db
        .prepare('SELECT DISTINCT value FROM account_names WHERE account_id = ? ORDER BY value')
        .all(post.author_account_id)
        .map((r) => r.value)
        .join('\n')
    : '';
  db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(postId);
  db.prepare('INSERT INTO posts_fts (post_id, text, alt_text, author_names) VALUES (?, ?, ?, ?)').run(
    postId,
    post.text ?? '',
    alt,
    names,
  );
}

function upsertPostRows(db, envelope) {
  assertEnvelope(envelope);
  if (!registeredService(db, envelope.service)) throw new Error(`unknown service: ${envelope.service}`);
  const now = Date.now();
  const freshest = [...envelope.versions].sort(
    (a, b) => (b.captured_at_ms ?? 0) - (a.captured_at_ms ?? 0) || String(b.service_version_id).localeCompare(String(a.service_version_id)),
  )[0];
  const author = upsertAccount(db, {
    service: envelope.service,
    service_account_id: envelope.author.service_account_id,
    screen_name: envelope.author.screen_name,
    display_name: envelope.author.display_name,
    status: envelope.author.status ?? 'unknown',
    observed_at: freshest.captured_at_ms ?? now,
  });
  const threadKey = deriveThreadKey(db, envelope, author.id);
  db.prepare(`
    INSERT INTO posts
      (service, service_post_key, author_account_id, created_at_ms, text, lang, url,
       is_sensitive, deleted, deleted_detected_at, counts_json, raw_json,
       reply_to_key, reply_to_author_id, quoted_key, thread_key, first_ingested_at, last_ingested_at)
    VALUES
      (@service, @service_post_key, @author_account_id, @created_at_ms, @text, @lang, @url,
       @is_sensitive, @deleted, @deleted_detected_at, @counts_json, @raw_json,
       @reply_to_key, @reply_to_author_id, @quoted_key, @thread_key, @now, @now)
    ON CONFLICT(service, service_post_key) DO UPDATE SET
      author_account_id = excluded.author_account_id,
      created_at_ms = COALESCE(excluded.created_at_ms, posts.created_at_ms),
      text = excluded.text,
      lang = excluded.lang,
      url = excluded.url,
      is_sensitive = excluded.is_sensitive,
      deleted = MAX(posts.deleted, excluded.deleted),
      deleted_detected_at = COALESCE(posts.deleted_detected_at, excluded.deleted_detected_at),
      counts_json = excluded.counts_json,
      raw_json = excluded.raw_json,
      reply_to_key = excluded.reply_to_key,
      reply_to_author_id = excluded.reply_to_author_id,
      quoted_key = excluded.quoted_key,
      thread_key = excluded.thread_key,
      last_ingested_at = excluded.last_ingested_at
  `).run({
    service: envelope.service,
    service_post_key: envelope.post_key,
    author_account_id: author.id,
    created_at_ms: envelope.created_at_ms,
    text: envelope.text,
    lang: envelope.lang,
    url: envelope.url,
    is_sensitive: envelope.is_sensitive ? 1 : 0,
    deleted: envelope.deleted ? 1 : 0,
    deleted_detected_at: envelope.deleted ? now : null,
    counts_json: json(envelope.counts),
    raw_json: json(freshest.raw),
    reply_to_key: envelope.reply_to?.key ?? null,
    reply_to_author_id: envelope.reply_to?.author_service_account_id ?? null,
    quoted_key: envelope.quoted_key ?? null,
    thread_key: threadKey,
    now,
  });
  const post = db.prepare('SELECT * FROM posts WHERE service = ? AND service_post_key = ?').get(envelope.service, envelope.post_key);
  const upsertVersion = db.prepare(`
    INSERT INTO post_versions (post_id, service_version_id, captured_at_ms, raw_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id, service_version_id) DO UPDATE SET
      captured_at_ms = excluded.captured_at_ms,
      raw_json = excluded.raw_json
  `);
  for (const version of envelope.versions) {
    upsertVersion.run(post.id, version.service_version_id, version.captured_at_ms ?? null, json(version.raw));
  }
  db.prepare('DELETE FROM media_items WHERE post_id = ?').run(post.id);
  const insertMedia = db.prepare(`
    INSERT INTO media_items (post_id, position, type, sha256, source_url, alt_text, width, height, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const media of envelope.media ?? []) {
    const haveFile = media.sha256 ? db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(media.sha256) : null;
    insertMedia.run(
      post.id,
      media.position,
      media.type,
      haveFile ? media.sha256 : null,
      media.source_url ?? null,
      media.alt_text ?? null,
      media.width ?? null,
      media.height ?? null,
      media.duration_ms ?? null,
    );
  }
  const upsertRelation = db.prepare(`
    INSERT INTO relations (relation_type_id, account_id, item_kind, item_id, value, observed_at, revoked_at)
    VALUES (?, ?, 'post', ?, ?, ?, ?)
    ON CONFLICT(relation_type_id, account_id, item_kind, item_id) DO UPDATE SET
      value = excluded.value,
      observed_at = excluded.observed_at,
      revoked_at = excluded.revoked_at
  `);
  for (const relation of envelope.relations ?? []) {
    if (relation.service === 'archivist') throw new Error('ingest refuses archivist-service relations');
    const type = relationType(db, envelope.service, relation.key);
    if (!type) continue;
    const subject = upsertAccount(db, {
      service: envelope.service,
      service_account_id: relation.subject.service_account_id,
      screen_name: relation.subject.screen_name,
      status: 'unknown',
      observed_at: relation.observed_at,
    });
    upsertRelation.run(type.id, subject.id, post.id, relation.value ?? null, relation.observed_at, relation.active ? null : relation.observed_at);
  }
  db.prepare(`
    UPDATE posts SET thread_key = ?
    WHERE service = ? AND reply_to_key = ? AND reply_to_author_id = ?
  `).run(post.thread_key ?? post.service_post_key, envelope.service, envelope.post_key, envelope.author.service_account_id);
  refreshFts(db, post.id);
  return post;
}

async function storeFile({ db, archiveRoot, envelope, media, bytes }) {
  const actual = sha256Hex(bytes);
  if (actual !== media.sha256) return { ok: false, reason: 'hash_mismatch', actual };
  const screen = sanitizeForFilename(envelope.author.screen_name ?? 'unknown');
  const base = sanitizeForFilename(media.original_basename ?? `${media.sha256}`);
  const relpath = path.join(envelope.service, screen, base);
  const fullPath = path.join(archiveRoot, relpath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  db.prepare(`
    INSERT OR IGNORE INTO files (sha256, relpath, bytes, mime, ingested_at, verified_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(media.sha256, relpath, bytes.length, null, Date.now(), Date.now());
  return { ok: true, relpath };
}

export function createIngest(library, { archiveRoot, log = () => {} } = {}) {
  const db = library.raw;
  const upsertTx = db.transaction((envelope) => upsertPostRows(db, envelope));

  async function ingestPost(envelope, fileProvider = async () => null) {
    const missingFiles = [];
    for (const media of envelope.media ?? []) {
      if (!media.sha256 || db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(media.sha256)) continue;
      const provided = await fileProvider(media.sha256, media);
      const bytes = provided?.bytes ? Buffer.from(provided.bytes) : null;
      if (!bytes) {
        missingFiles.push(media.sha256);
        continue;
      }
      const stored = await storeFile({ db, archiveRoot, envelope, media, bytes });
      if (!stored.ok) {
        log(`refused file ${media.sha256}: ${stored.reason}`);
        missingFiles.push(media.sha256);
      }
    }
    const post = upsertTx(envelope);
    return { post_id: post.id, missing_files: missingFiles };
  }

  function rebuildFts() {
    const rows = db.prepare('SELECT id FROM posts ORDER BY id').all();
    for (const row of rows) refreshFts(db, row.id);
    return rows.length;
  }

  function rebuildThreads() {
    const rows = db.prepare('SELECT * FROM posts ORDER BY created_at_ms, id').all();
    for (const row of rows) {
      const author = db.prepare('SELECT service_account_id FROM accounts WHERE id = ?').get(row.author_account_id);
      const threadKey =
        row.reply_to_key && row.reply_to_author_id === author?.service_account_id
          ? db.prepare('SELECT thread_key FROM posts WHERE service = ? AND service_post_key = ?').get(row.service, row.reply_to_key)?.thread_key ?? row.reply_to_key
          : row.service_post_key;
      db.prepare('UPDATE posts SET thread_key = ? WHERE id = ?').run(threadKey, row.id);
    }
    return rows.length;
  }

  return { ingestPost, rebuildFts, rebuildThreads };
}

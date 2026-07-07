/**
 * db.js — the companion app's SQLite library (plan 06 §3, WAL mode).
 *
 * Two-tier model (Decision 19): seen (metadata only, automatic) → queued
 * (user picked) → archived (media on disk). One `posts` row per LOGICAL
 * post — the edit-group key is `edit_initial_id_str ?? id_str`
 * (Decision 17); each tweet id (= each edit) is a `versions` row.
 *
 * Deletion is passive only (Decision 18): captured tombstones and 404/410
 * during archiving set deleted=1 — nothing ever polls X.
 */

import Database from 'better-sqlite3';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS posts (
  post_key            TEXT PRIMARY KEY,
  author_id           TEXT,
  author_screen_name  TEXT,
  first_seen_at       INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  state               TEXT NOT NULL DEFAULT 'seen'
                      CHECK(state IN ('seen','queued','archived','archive_failed')),
  deleted             INTEGER NOT NULL DEFAULT 0,
  deleted_detected_at INTEGER
);

CREATE TABLE IF NOT EXISTS versions (
  id_str          TEXT PRIMARY KEY,
  post_key        TEXT NOT NULL REFERENCES posts(post_key),
  created_at_ms   INTEGER,
  full_text       TEXT,
  lang            TEXT,
  counts_json     TEXT,
  entities_json   TEXT,
  source_op       TEXT,
  captured_at_ms  INTEGER,
  raw_record_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_post_key ON versions(post_key);

CREATE TABLE IF NOT EXISTS media (
  media_key           TEXT PRIMARY KEY,
  id_str              TEXT NOT NULL REFERENCES versions(id_str),
  type                TEXT,
  position            INTEGER,
  orig_url            TEXT,
  video_variants_json TEXT,
  alt_text            TEXT,
  width               INTEGER,
  height              INTEGER,
  duration_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_id_str ON media(id_str);

CREATE TABLE IF NOT EXISTS files (
  media_key     TEXT NOT NULL REFERENCES media(media_key),
  path          TEXT NOT NULL,
  bytes         INTEGER,
  sha256        TEXT,
  downloaded_at INTEGER,
  UNIQUE(sha256)
);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  post_key UNINDEXED, full_text, alt_text, author_screen_name, author_name
);
`;

/** post_key for a TweetRecord (Decision 17). */
export function postKeyFor(record) {
  return record.edit_initial_id_str ?? record.id_str;
}

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return createLibrary(db);
}

function createLibrary(db) {
  const upsertPost = db.prepare(`
    INSERT INTO posts (post_key, author_id, author_screen_name, first_seen_at, last_seen_at)
    VALUES (@post_key, @author_id, @author_screen_name, @seen_at, @seen_at)
    ON CONFLICT(post_key) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      author_id = COALESCE(excluded.author_id, posts.author_id),
      author_screen_name = COALESCE(excluded.author_screen_name, posts.author_screen_name)
  `);
  const upsertVersion = db.prepare(`
    INSERT OR REPLACE INTO versions
      (id_str, post_key, created_at_ms, full_text, lang, counts_json,
       entities_json, source_op, captured_at_ms, raw_record_json)
    VALUES (@id_str, @post_key, @created_at_ms, @full_text, @lang, @counts_json,
            @entities_json, @source_op, @captured_at_ms, @raw_record_json)
  `);
  const upsertMedia = db.prepare(`
    INSERT OR REPLACE INTO media
      (media_key, id_str, type, position, orig_url, video_variants_json,
       alt_text, width, height, duration_ms)
    VALUES (@media_key, @id_str, @type, @position, @orig_url, @video_variants_json,
            @alt_text, @width, @height, @duration_ms)
  `);
  const deleteFts = db.prepare('DELETE FROM posts_fts WHERE post_key = ?');
  const insertFts = db.prepare(`
    INSERT INTO posts_fts (post_key, full_text, alt_text, author_screen_name, author_name)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getPost = db.prepare('SELECT * FROM posts WHERE post_key = ?');
  const setState = db.prepare('UPDATE posts SET state = ? WHERE post_key = ?');
  const markDeletedByPostKey = db.prepare(`
    UPDATE posts SET deleted = 1, deleted_detected_at = COALESCE(deleted_detected_at, ?)
    WHERE post_key = ?
  `);
  const postKeyForVersion = db.prepare('SELECT post_key FROM versions WHERE id_str = ?');
  const insertFile = db.prepare(`
    INSERT INTO files (media_key, path, bytes, sha256, downloaded_at)
    VALUES (@media_key, @path, @bytes, @sha256, @downloaded_at)
  `);
  const fileBySha = db.prepare('SELECT * FROM files WHERE sha256 = ?');

  /**
   * The seen-ingest upsert (plan 06 §3): later captures refresh
   * counts/last_seen_at; a new tweet id inside an existing edit-group adds
   * a versions row (edit history accretes passively). Never downgrades
   * state — a re-seen archived post stays archived.
   */
  const ingestSeen = db.transaction((record, seenAt = Date.now()) => {
    const post_key = postKeyFor(record);
    upsertPost.run({
      post_key,
      author_id: record.user.id_str,
      author_screen_name: record.user.screen_name,
      seen_at: seenAt,
    });
    upsertVersion.run({
      id_str: record.id_str,
      post_key,
      created_at_ms: record.created_at_ms,
      full_text: record.full_text,
      lang: record.lang,
      counts_json: JSON.stringify(record.counts),
      entities_json: JSON.stringify({
        urls: record.urls,
        hashtags: record.hashtags,
        mentions: record.mentions,
      }),
      source_op: record.source_op,
      captured_at_ms: record.captured_at_ms,
      raw_record_json: JSON.stringify(record),
    });
    for (const media of record.media) {
      upsertMedia.run({
        media_key: media.media_key ?? `${record.id_str}:${media.index}`,
        id_str: record.id_str,
        type: media.type,
        position: media.index,
        orig_url: media.image_url,
        video_variants_json: JSON.stringify(media.video_variants),
        alt_text: media.alt_text,
        width: media.width,
        height: media.height,
        duration_ms: media.duration_ms,
      });
    }
    deleteFts.run(post_key);
    insertFts.run(
      post_key,
      record.full_text,
      record.media.map((m) => m.alt_text).filter(Boolean).join('\n'),
      record.user.screen_name,
      record.user.name,
    );
    return post_key;
  });

  return {
    raw: db,
    ingestSeen,

    /** archive request: ingest (fresh metadata) + move seen→queued. */
    ingestArchiveRequest(record, seenAt = Date.now()) {
      const post_key = ingestSeen(record, seenAt);
      const post = getPost.get(post_key);
      if (post.state === 'seen' || post.state === 'archive_failed') {
        setState.run('queued', post_key);
      }
      return post_key;
    },

    setPostState(post_key, state) {
      setState.run(state, post_key);
    },

    /**
     * Passive deletion flag (Decision 18): from a captured tombstone or a
     * 404/410 during archiving. Accepts a tweet id — resolves through
     * versions to the edit-group when known, else tries it as a post_key.
     * Returns true if a post was flagged.
     */
    markDeleted(tweetId, detectedAt = Date.now()) {
      if (!tweetId) return false;
      const version = postKeyForVersion.get(tweetId);
      const post_key = version ? version.post_key : tweetId;
      return markDeletedByPostKey.run(detectedAt, post_key).changes > 0;
    },

    getPost(post_key) {
      return getPost.get(post_key);
    },

    getVersions(post_key) {
      return db.prepare('SELECT * FROM versions WHERE post_key = ? ORDER BY id_str').all(post_key);
    },

    getMedia(id_str) {
      return db.prepare('SELECT * FROM media WHERE id_str = ? ORDER BY position').all(id_str);
    },

    findFileBySha(sha256) {
      return fileBySha.get(sha256) ?? null;
    },

    recordFile({ media_key, path, bytes, sha256, downloaded_at = Date.now() }) {
      insertFile.run({ media_key, path, bytes, sha256, downloaded_at });
    },

    searchPosts(query) {
      return db
        .prepare(
          `SELECT p.* FROM posts_fts f JOIN posts p ON p.post_key = f.post_key
           WHERE posts_fts MATCH ? ORDER BY p.last_seen_at DESC`,
        )
        .all(query);
    },

    stats() {
      const row = (sql) => db.prepare(sql).get();
      return {
        posts: row('SELECT COUNT(*) AS n FROM posts').n,
        versions: row('SELECT COUNT(*) AS n FROM versions').n,
        media: row('SELECT COUNT(*) AS n FROM media').n,
        files: row('SELECT COUNT(*) AS n FROM files').n,
        archived: row("SELECT COUNT(*) AS n FROM posts WHERE state = 'archived'").n,
        queued: row("SELECT COUNT(*) AS n FROM posts WHERE state = 'queued'").n,
        deleted: row('SELECT COUNT(*) AS n FROM posts WHERE deleted = 1').n,
      };
    },

    close() {
      db.close();
    },
  };
}

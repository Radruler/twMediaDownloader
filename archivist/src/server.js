import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createIngest, mimeForBasename, UPLOAD_STAGING_DIR } from './ingest.js';

const JSON_LIMIT = 1024 * 1024;

/** Errors that carry their own HTTP status (everything else maps to 400). */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (message) => new HttpError(404, 'not_found', message);

/** Opaque keyset cursor over (sort key, id) — API.md list convention. */
function encodeCursor(k, id) {
  return Buffer.from(JSON.stringify({ k, id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return typeof parsed?.id === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function pageParams(url) {
  return {
    limit: Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 60) || 60, 200)),
    cursor: decodeCursor(url.searchParams.get('cursor')),
  };
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function error(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

function hashToken(value) {
  return createHash('sha256').update(String(value ?? '')).digest();
}

function tokenMatches(got, expected) {
  return timingSafeEqual(hashToken(got), hashToken(expected));
}

function authToken(req, url) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return url.searchParams.get('token');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new Error('json body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

function accountRef(db, row) {
  if (!row) return null;
  const names = db
    .prepare(
      `SELECT kind, value FROM account_names
       WHERE account_id = ?
       ORDER BY last_observed_at DESC, first_observed_at DESC`,
    )
    .all(row.id);
  const screen = names.find((n) => n.kind === 'screen_name')?.value ?? null;
  const display = names.find((n) => n.kind === 'display_name')?.value ?? null;
  const persona = db
    .prepare(
      `SELECT p.id, p.name FROM personas p
       JOIN persona_accounts pa ON pa.persona_id = p.id
       WHERE pa.account_id = ?`,
    )
    .get(row.id) ?? null;
  return {
    id: row.id,
    service: row.service,
    service_account_id: row.service_account_id,
    screen_name: screen,
    display_name: display,
    is_me: row.is_me === 1,
    is_stub: row.service_account_id.startsWith('~'),
    status: row.status,
    persona,
  };
}

function mediaRows(db, postId) {
  return db
    .prepare(
      `SELECT m.*, f.bytes, f.mime FROM media_items m
       LEFT JOIN files f ON f.sha256 = m.sha256
       WHERE m.post_id = ?
       ORDER BY m.position`,
    )
    .all(postId)
    .map((m) => ({
      id: m.id,
      post_id: m.post_id,
      position: m.position,
      type: m.type,
      sha256: m.sha256,
      available: !!m.sha256 && m.bytes != null,
      bytes: m.bytes ?? null,
      mime: m.mime ?? null,
      source_url: m.source_url,
      alt_text: m.alt_text,
      width: m.width,
      height: m.height,
      duration_ms: m.duration_ms,
    }));
}

function relationRows(db, kind, id) {
  return db
    .prepare(
      `SELECT rt.service, rt.key, r.value, r.account_id, r.observed_at, r.revoked_at
       FROM relations r JOIN relation_types rt ON rt.id = r.relation_type_id
       WHERE r.item_kind = ? AND r.item_id = ? AND r.revoked_at IS NULL
       ORDER BY rt.service, rt.key`,
    )
    .all(kind, id);
}

function tagsFor(db, kind, id) {
  return db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN tag_items ti ON ti.tag_id = t.id
       WHERE ti.item_kind = ? AND ti.item_id = ?
       ORDER BY t.name COLLATE NOCASE`,
    )
    .all(kind, id)
    .map((t) => t.name);
}

function itemTable(kind) {
  if (kind === 'post') return 'posts';
  if (kind === 'media') return 'media_items';
  return null;
}

function itemExists(db, kind, id) {
  const table = itemTable(kind);
  return table ? !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) : false;
}

/** The service an item belongs to (post directly; media via its post). */
function itemService(db, kind, id) {
  if (kind === 'post') return db.prepare('SELECT service FROM posts WHERE id = ?').get(id)?.service ?? null;
  return db
    .prepare('SELECT p.service FROM media_items m JOIN posts p ON p.id = m.post_id WHERE m.id = ?')
    .get(id)?.service ?? null;
}

function setItemTags(db, kind, id, names) {
  if (!itemExists(db, kind, id)) throw notFound('item not found');
  const now = Date.now();
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
  const clear = db.prepare('DELETE FROM tag_items WHERE item_kind = ? AND item_id = ?');
  const insertItem = db.prepare('INSERT OR IGNORE INTO tag_items (tag_id, item_kind, item_id, tagged_at) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    clear.run(kind, id);
    for (const raw of names ?? []) {
      const name = String(raw).trim();
      if (!name) continue;
      insertTag.run(name);
      insertItem.run(getTag.get(name).id, kind, id, now);
    }
  });
  tx();
  return tagsFor(db, kind, id);
}

function setArchivistRelation(db, kind, id, service, key, body) {
  if (service !== 'archivist') throw new HttpError(403, 'refused', 'captured-service relations are read-only');
  if (!itemExists(db, kind, id)) throw notFound('item not found');
  const type = db.prepare('SELECT * FROM relation_types WHERE service = ? AND key = ?').get(service, key);
  if (!type) throw notFound('unknown relation type');
  const account = db.prepare("SELECT * FROM accounts WHERE service = 'archivist' AND service_account_id = 'me'").get();
  const now = Date.now();
  db.prepare(`
    INSERT INTO relations (relation_type_id, account_id, item_kind, item_id, value, observed_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relation_type_id, account_id, item_kind, item_id) DO UPDATE SET
      value = excluded.value,
      observed_at = excluded.observed_at,
      revoked_at = excluded.revoked_at
  `).run(type.id, account.id, kind, id, body.value == null ? null : String(body.value), now, body.active === false ? now : null);
}

function creditsFor(db, kind, id) {
  return db
    .prepare(
      `SELECT c.*, a.* FROM credits c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.item_kind = ? AND c.item_id = ?
       ORDER BY c.role, c.id`,
    )
    .all(kind, id)
    .map((row) => ({
      account: accountRef(db, row),
      role: row.role,
      item_kind: kind,
      item_id: id,
      source: row.source,
    }));
}

function createStubAccount(db, service, screenName) {
  const serviceAccountId = `~${String(screenName).replace(/^@/, '')}`;
  db.prepare(`
    INSERT OR IGNORE INTO accounts (service, service_account_id, status, first_seen_at, last_seen_at)
    VALUES (?, ?, 'unknown', ?, ?)
  `).run(service, serviceAccountId, Date.now(), Date.now());
  const account = db.prepare('SELECT * FROM accounts WHERE service = ? AND service_account_id = ?').get(service, serviceAccountId);
  db.prepare(`
    INSERT OR IGNORE INTO account_names (account_id, kind, value, first_observed_at, last_observed_at)
    VALUES (?, 'screen_name', ?, ?, ?)
  `).run(account.id, String(screenName).replace(/^@/, ''), Date.now(), Date.now());
  return account;
}

function setCredits(db, kind, id, credits) {
  if (!itemExists(db, kind, id)) throw notFound('item not found');
  const service = itemService(db, kind, id);
  const now = Date.now();
  const clear = db.prepare('DELETE FROM credits WHERE item_kind = ? AND item_id = ?');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO credits (item_kind, item_id, account_id, role, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    clear.run(kind, id);
    for (const credit of credits ?? []) {
      let accountId = credit.account_id;
      let source = 'manual';
      if (!accountId && credit.new_account) {
        accountId = createStubAccount(db, credit.new_account.service, credit.new_account.screen_name).id;
      }
      if (!accountId && credit.accept_suggestion) {
        // A suggestion always came from the item's own service's capture data.
        accountId = createStubAccount(db, service, credit.accept_suggestion.screen_name).id;
        source = 'accepted_suggestion';
      }
      if (!accountId || !credit.role) continue;
      insert.run(kind, id, accountId, credit.role, source, now);
    }
  });
  tx();
  return creditsFor(db, kind, id);
}

/**
 * Computed credit suggestions (plan V-1): mentions + media tagged users
 * from the freshest raw record. Never stored — accepting one creates the
 * credit row (Decision 15).
 */
function suggestionsFor(db, kind, id) {
  const postId = kind === 'post' ? id : db.prepare('SELECT post_id FROM media_items WHERE id = ?').get(id)?.post_id;
  if (!postId) return [];
  const row = db.prepare('SELECT service, raw_json FROM posts WHERE id = ?').get(postId);
  if (!row?.raw_json) return [];
  let record;
  try {
    record = JSON.parse(row.raw_json);
  } catch {
    return [];
  }
  const found = new Map();
  for (const screen of record?.mentions ?? []) {
    if (typeof screen === 'string' && screen) found.set(screen.toLowerCase(), { screen_name: screen, provenance: 'mention' });
  }
  for (const media of record?.media ?? []) {
    for (const user of media?.tagged_users ?? []) {
      if (user?.screen_name) found.set(String(user.screen_name).toLowerCase(), { screen_name: user.screen_name, provenance: 'tagged_user' });
    }
  }
  return [...found.values()].map((s) => {
    const named = db
      .prepare(
        `SELECT a.* FROM accounts a JOIN account_names n ON n.account_id = a.id
         WHERE a.service = ? AND n.kind = 'screen_name' AND n.value = ? COLLATE NOCASE
         ORDER BY n.last_observed_at DESC LIMIT 1`,
      )
      .get(row.service, s.screen_name);
    return { account: named ? accountRef(db, named) : null, screen_name: s.screen_name, provenance: s.provenance };
  });
}

function postShape(db, row) {
  const author = row.author_account_id
    ? accountRef(db, db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.author_account_id))
    : null;
  const relations = relationRows(db, 'post', row.id);
  const rating = relations.find((r) => r.service === 'archivist' && r.key === 'rating')?.value ?? null;
  return {
    id: row.id,
    service: row.service,
    service_post_key: row.service_post_key,
    author,
    created_at_ms: row.created_at_ms,
    text: row.text,
    lang: row.lang,
    url: row.url,
    is_sensitive: row.is_sensitive === 1,
    deleted: row.deleted === 1,
    deleted_detected_at: row.deleted_detected_at,
    counts: row.counts_json ? JSON.parse(row.counts_json) : null,
    reply_to_key: row.reply_to_key,
    quoted_key: row.quoted_key,
    thread_key: row.thread_key,
    media: mediaRows(db, row.id),
    relations,
    tags: tagsFor(db, 'post', row.id),
    rating: rating == null ? null : Number(rating),
    favorite: relations.some((r) => r.service === 'archivist' && r.key === 'favorite'),
    first_ingested_at: row.first_ingested_at,
    last_ingested_at: row.last_ingested_at,
  };
}

function listPosts(db, url) {
  const { limit, cursor } = pageParams(url);
  const deleted = url.searchParams.get('deleted') ?? 'exclude';
  const where = [];
  const args = [];
  if (deleted === 'exclude') where.push('deleted = 0');
  if (deleted === 'only') where.push('deleted = 1');
  if (cursor) {
    where.push('(COALESCE(created_at_ms, 0) < ? OR (COALESCE(created_at_ms, 0) = ? AND id < ?))');
    args.push(cursor.k, cursor.k, cursor.id);
  }
  const sql = `SELECT * FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(created_at_ms, 0) DESC, id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => postShape(db, row)),
    next_cursor: rows.length === limit ? encodeCursor(last.created_at_ms ?? 0, last.id) : null,
  };
}

/**
 * Thread roots, deterministically: the root of a work is its earliest part
 * by (created_at_ms, id). (A bare GROUP BY over SELECT * would hand back an
 * arbitrary row per group — SQLite bare-column semantics.)
 */
function listWorks(db, url) {
  const { limit, cursor } = pageParams(url);
  const where = [
    `NOT EXISTS (
      SELECT 1 FROM posts q
      WHERE q.service = p.service AND q.thread_key = p.thread_key
        AND (COALESCE(q.created_at_ms, 0) < COALESCE(p.created_at_ms, 0)
             OR (COALESCE(q.created_at_ms, 0) = COALESCE(p.created_at_ms, 0) AND q.id < p.id)))`,
  ];
  const args = [];
  if (cursor) {
    where.push('(COALESCE(p.created_at_ms, 0) < ? OR (COALESCE(p.created_at_ms, 0) = ? AND p.id < ?))');
    args.push(cursor.k, cursor.k, cursor.id);
  }
  const rows = db
    .prepare(
      `SELECT p.* FROM posts p WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(p.created_at_ms, 0) DESC, p.id DESC LIMIT ?`,
    )
    .all(...args, limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => workShape(db, row)),
    next_cursor: rows.length === limit ? encodeCursor(last.created_at_ms ?? 0, last.id) : null,
  };
}

function workShape(db, row, { withSuggestions = false } = {}) {
  const threadKey = row.thread_key ?? row.service_post_key;
  const partRows = db
    .prepare('SELECT * FROM posts WHERE service = ? AND thread_key = ? ORDER BY COALESCE(created_at_ms, 0) ASC, id ASC')
    .all(row.service, threadKey);
  const parts = partRows.map((part) => postShape(db, part));
  // Honesty marker: same-author reply keys that resolve to nothing we hold
  // (neither a post key nor a captured version id) are missing parts.
  const knownKeys = new Set(partRows.map((p) => p.service_post_key));
  for (const part of partRows) {
    for (const version of db.prepare('SELECT service_version_id FROM post_versions WHERE post_id = ?').all(part.id)) {
      knownKeys.add(version.service_version_id);
    }
  }
  const missingKeys = new Set();
  for (const part of partRows) {
    const authorId = part.author_account_id
      ? db.prepare('SELECT service_account_id FROM accounts WHERE id = ?').get(part.author_account_id)?.service_account_id
      : null;
    if (part.reply_to_key && part.reply_to_author_id === authorId && !knownKeys.has(part.reply_to_key)) {
      missingKeys.add(part.reply_to_key);
    }
  }
  return {
    thread_key: threadKey,
    root_post_id: parts[0]?.id ?? row.id,
    parts,
    media: parts.flatMap((part, partIndex) => part.media.map((m) => ({ part_index: partIndex, ...m }))),
    description: parts.map((part) => ({ post_id: part.id, text: part.text, created_at_ms: part.created_at_ms, url: part.url })),
    credits: parts.flatMap((part) => creditsFor(db, 'post', part.id)),
    suggestions: withSuggestions ? (parts[0] ? suggestionsFor(db, 'post', parts[0].id) : []) : null,
    missing_parts: missingKeys.size,
    quoted: partRows
      .filter((part) => part.quoted_key)
      .map((part) => {
        const quotedRow = db
          .prepare(
            `SELECT p.* FROM posts p
             LEFT JOIN post_versions v ON v.post_id = p.id
             WHERE p.service = ? AND (p.service_post_key = ? OR v.service_version_id = ?) LIMIT 1`,
          )
          .get(row.service, part.quoted_key, part.quoted_key);
        return { key: part.quoted_key, post: quotedRow ? postShape(db, quotedRow) : null };
      }),
  };
}

async function serveFile(req, res, db, archiveRoot, sha256) {
  const row = db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256);
  if (!row) return error(res, 404, 'not_found', 'file not found');
  const fullPath = path.join(archiveRoot, row.relpath);
  const info = await stat(fullPath).catch(() => null);
  if (!info) return error(res, 404, 'not_found', 'file missing');
  const mime = row.mime || mimeForBasename(row.relpath) || 'application/octet-stream';
  const baseHeaders = {
    'content-type': mime,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  };
  // Single-range support so <video> can seek (API.md /files contract).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'content-length': end - start + 1,
    });
    return createReadStream(fullPath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...baseHeaders, 'content-length': info.size });
  createReadStream(fullPath).pipe(res);
}

/**
 * Streamed upload (pinned in plan B-6): bytes go to a temp file while the
 * hash accumulates — never buffered in memory. Verified files stage at
 * `_uploads/<sha256>`; ingest relocates them into the Decision-4 tree when
 * their post envelope arrives.
 */
async function uploadFile(req, res, db, archiveRoot, sha256, maxBytes) {
  if (db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(sha256)) {
    return json(res, 200, { ok: true }); // idempotent duplicate upload
  }
  const tmpDir = path.join(archiveRoot, '_tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${sha256}.${process.pid}.${Date.now()}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) throw new HttpError(400, 'bad_request', 'upload too large');
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmpPath, { flags: 'wx' }),
    );
    if (hash.digest('hex') !== sha256) {
      throw new HttpError(409, 'conflict', 'hash mismatch');
    }
    const relpath = path.join(UPLOAD_STAGING_DIR, sha256);
    const fullPath = path.join(archiveRoot, relpath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await rename(tmpPath, fullPath);
    db.prepare(`
      INSERT OR IGNORE INTO files (sha256, relpath, bytes, mime, ingested_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sha256, relpath, size, null, Date.now(), Date.now());
    json(res, 200, { ok: true });
  } finally {
    await rm(tmpPath, { force: true });
  }
}

export function createArchivistServer({ library, config, host = config.bind_host, port = config.port, log = () => {} }) {
  const db = library.raw;
  const ingest = createIngest(library, { archiveRoot: config.archive_root, log });
  const maxUploadBytes = config.max_upload_bytes ?? 2 * 1024 * 1024 * 1024;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Archivist</title><main><h1>Archivist</h1><p>API ready.</p></main>');
        return;
      }
      const protectedPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname.startsWith('/thumbs/');
      if (protectedPath && !tokenMatches(authToken(req, url), config.api_token)) {
        return error(res, 401, 'unauthorized', 'missing or invalid token');
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        const stats = library.stats();
        const dbBytes = config.db_path ? await stat(config.db_path).then((s) => s.size).catch(() => 0) : 0;
        return json(res, 200, {
          posts: stats.posts,
          media: stats.media,
          files: stats.files,
          accounts: stats.accounts,
          personas: db.prepare('SELECT COUNT(*) AS n FROM personas').get().n,
          tags: stats.tags,
          by_service: Object.fromEntries(db.prepare('SELECT service, COUNT(*) AS posts FROM posts GROUP BY service').all().map((r) => [r.service, { posts: r.posts }])),
          deleted: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE deleted = 1').get().n,
          db_bytes: dbBytes,
          archive_bytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM files').get().n,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/relation-types') {
        const items = db.prepare('SELECT service, key, label, value_kind, value_meta_json FROM relation_types ORDER BY service, key').all()
          .map((r) => ({ service: r.service, key: r.key, label: r.label, value_kind: r.value_kind, value_meta: r.value_meta_json ? JSON.parse(r.value_meta_json) : null }));
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') return json(res, 200, listPosts(db, url));
      if (req.method === 'GET' && url.pathname === '/api/works') return json(res, 200, listWorks(db, url));
      const postMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);
      if (req.method === 'GET' && postMatch) {
        const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(postMatch[1]));
        return row ? json(res, 200, postShape(db, row)) : error(res, 404, 'not_found', 'post not found');
      }
      const workMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
      if (req.method === 'GET' && workMatch) {
        const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(workMatch[1]));
        return row ? json(res, 200, workShape(db, row, { withSuggestions: true })) : error(res, 404, 'not_found', 'work not found');
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/(\d+)$/);
      if (req.method === 'GET' && mediaMatch) {
        const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(Number(mediaMatch[1]));
        if (!row) return error(res, 404, 'not_found', 'media not found');
        const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.post_id);
        return json(res, 200, { ...mediaRows(db, row.post_id).find((m) => m.id === row.id), post: postShape(db, post) });
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const items = db
          .prepare('SELECT * FROM accounts ORDER BY last_seen_at DESC, id DESC LIMIT 200')
          .all()
          .map((row) => ({
            ...accountRef(db, row),
            posts_n: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_account_id = ?').get(row.id).n,
            names_n: db.prepare('SELECT COUNT(*) AS n FROM account_names WHERE account_id = ?').get(row.id).n,
          }));
        return json(res, 200, { items, next_cursor: null });
      }
      const accountDetail = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
      if (req.method === 'GET' && accountDetail) {
        const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountDetail[1]));
        if (!row) return error(res, 404, 'not_found', 'account not found');
        return json(res, 200, {
          ...accountRef(db, row),
          posts_n: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_account_id = ?').get(row.id).n,
          names: db
            .prepare('SELECT kind, value, first_observed_at, last_observed_at FROM account_names WHERE account_id = ? ORDER BY first_observed_at, value')
            .all(row.id),
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/personas') {
        const items = db.prepare('SELECT * FROM personas ORDER BY name COLLATE NOCASE, id').all().map((p) => ({
          id: p.id,
          name: p.name,
          notes: p.notes,
          accounts: db
            .prepare('SELECT a.* FROM accounts a JOIN persona_accounts pa ON pa.account_id = a.id WHERE pa.persona_id = ? ORDER BY a.id')
            .all(p.id)
            .map((a) => accountRef(db, a)),
        }));
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && url.pathname === '/api/tags') {
        const items = db
          .prepare(
            `SELECT t.id, t.name, COUNT(ti.tag_id) AS uses FROM tags t
             LEFT JOIN tag_items ti ON ti.tag_id = t.id
             GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
          )
          .all();
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && url.pathname === '/api/credit-roles') return json(res, 200, { items: db.prepare('SELECT role, label FROM credit_roles ORDER BY role').all() });

      if (req.method === 'POST' && url.pathname === '/api/personas') {
        const body = await readJson(req);
        const info = db.prepare('INSERT INTO personas (name, notes) VALUES (?, ?)').run(body.name, body.notes ?? null);
        return json(res, 200, db.prepare('SELECT * FROM personas WHERE id = ?').get(info.lastInsertRowid));
      }
      const personaMatch = url.pathname.match(/^\/api\/personas\/(\d+)$/);
      if (personaMatch && req.method === 'PATCH') {
        const body = await readJson(req);
        db.prepare('UPDATE personas SET name = COALESCE(?, name), notes = COALESCE(?, notes) WHERE id = ?').run(body.name ?? null, body.notes ?? null, Number(personaMatch[1]));
        return json(res, 200, db.prepare('SELECT * FROM personas WHERE id = ?').get(Number(personaMatch[1])));
      }
      if (personaMatch && req.method === 'DELETE') {
        db.prepare('DELETE FROM persona_accounts WHERE persona_id = ?').run(Number(personaMatch[1]));
        db.prepare('DELETE FROM personas WHERE id = ?').run(Number(personaMatch[1]));
        return json(res, 200, { ok: true });
      }
      const personaAccount = url.pathname.match(/^\/api\/personas\/(\d+)\/accounts\/(\d+)$/);
      if (personaAccount && req.method === 'PUT') {
        db.prepare('DELETE FROM persona_accounts WHERE account_id = ?').run(Number(personaAccount[2]));
        db.prepare('INSERT INTO persona_accounts (persona_id, account_id) VALUES (?, ?)').run(Number(personaAccount[1]), Number(personaAccount[2]));
        return json(res, 200, { ok: true });
      }
      if (personaAccount && req.method === 'DELETE') {
        db.prepare('DELETE FROM persona_accounts WHERE persona_id = ? AND account_id = ?').run(Number(personaAccount[1]), Number(personaAccount[2]));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/tags') {
        const body = await readJson(req);
        db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(body.name);
        return json(res, 200, db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(body.name));
      }
      const tagsMatch = url.pathname.match(/^\/api\/items\/(post|media)\/(\d+)\/tags$/);
      if (tagsMatch && req.method === 'PUT') {
        const body = await readJson(req);
        return json(res, 200, { tags: setItemTags(db, tagsMatch[1], Number(tagsMatch[2]), body.names) });
      }
      const relationMatch = url.pathname.match(/^\/api\/items\/(post|media)\/(\d+)\/relations\/([^/]+)\/([^/]+)$/);
      if (relationMatch && req.method === 'PUT') {
        const body = await readJson(req);
        setArchivistRelation(db, relationMatch[1], Number(relationMatch[2]), relationMatch[3], relationMatch[4], body);
        return json(res, 200, { ok: true });
      }
      const accountPatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/);
      if (accountPatch && req.method === 'PATCH') {
        const body = await readJson(req);
        db.prepare('UPDATE accounts SET is_me = ? WHERE id = ?').run(body.is_me ? 1 : 0, Number(accountPatch[1]));
        return json(res, 200, accountRef(db, db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountPatch[1]))));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const body = await readJson(req);
        return json(res, 200, accountRef(db, createStubAccount(db, body.service, body.screen_name)));
      }
      if (req.method === 'POST' && url.pathname === '/api/credit-roles') {
        const body = await readJson(req);
        db.prepare('INSERT OR IGNORE INTO credit_roles (role, label) VALUES (?, ?)').run(body.role, body.label);
        return json(res, 200, db.prepare('SELECT * FROM credit_roles WHERE role = ?').get(body.role));
      }
      const creditsMatch = url.pathname.match(/^\/api\/items\/(post|media)\/(\d+)\/credits$/);
      if (creditsMatch && req.method === 'GET') {
        const [, kind, rawId] = creditsMatch;
        const id = Number(rawId);
        if (!itemExists(db, kind, id)) return error(res, 404, 'not_found', 'item not found');
        return json(res, 200, { credits: creditsFor(db, kind, id), suggestions: suggestionsFor(db, kind, id) });
      }
      if (creditsMatch && req.method === 'PUT') {
        const body = await readJson(req);
        return json(res, 200, { credits: setCredits(db, creditsMatch[1], Number(creditsMatch[2]), body.credits) });
      }

      if (req.method === 'POST' && url.pathname === '/api/ingest/post') {
        const body = await readJson(req);
        try {
          const result = await ingest.ingestPost(body, async () => null);
          return json(res, 200, { ok: true, post_id: result.post_id, missing_files: result.missing_files });
        } catch (err) {
          const message = String(err?.message ?? err);
          if (message.includes("reserved 'archivist'") || message.startsWith('unknown service')) {
            throw new HttpError(403, 'refused', message);
          }
          throw err;
        }
      }
      const ingestFile = url.pathname.match(/^\/api\/ingest\/file\/([a-fA-F0-9]{64})$/);
      if (req.method === 'PUT' && ingestFile) return uploadFile(req, res, db, config.archive_root, ingestFile[1].toLowerCase(), maxUploadBytes);

      const fileMatch = url.pathname.match(/^\/files\/([a-fA-F0-9]{64})$/);
      if (req.method === 'GET' && fileMatch) return serveFile(req, res, db, config.archive_root, fileMatch[1].toLowerCase());
      const thumbMatch = url.pathname.match(/^\/thumbs\/([a-fA-F0-9]{64})$/);
      if (req.method === 'GET' && thumbMatch) return serveFile(req, res, db, config.archive_root, thumbMatch[1].toLowerCase());

      return error(res, 404, 'not_found', 'route not found');
    } catch (err) {
      log(String(err?.stack ?? err));
      if (err instanceof HttpError) return error(res, err.status, err.code, err.message);
      if (res.headersSent) return res.end();
      return error(res, 400, 'bad_request', String(err?.message ?? err));
    }
  });
  server.listen(port, host);
  return {
    server,
    get port() {
      return server.address()?.port;
    },
    ready: new Promise((resolve) => server.once('listening', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

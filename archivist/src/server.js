import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createIngest } from './ingest.js';

const JSON_LIMIT = 1024 * 1024;

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

async function readBytes(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('upload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

function setItemTags(db, kind, id, names) {
  if (!itemExists(db, kind, id)) throw new Error('item not found');
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
  if (service !== 'archivist') throw new Error('captured-service relations are read-only');
  if (!itemExists(db, kind, id)) throw new Error('item not found');
  const type = db.prepare('SELECT * FROM relation_types WHERE service = ? AND key = ?').get(service, key);
  if (!type) throw new Error('unknown relation type');
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
  if (!itemExists(db, kind, id)) throw new Error('item not found');
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
        accountId = createStubAccount(db, 'twitter', credit.accept_suggestion.screen_name).id;
        source = 'accepted_suggestion';
      }
      if (!accountId || !credit.role) continue;
      insert.run(kind, id, accountId, credit.role, source, now);
    }
  });
  tx();
  return creditsFor(db, kind, id);
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
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 60), 200);
  const deleted = url.searchParams.get('deleted') ?? 'exclude';
  const where = [];
  const args = [];
  if (deleted === 'exclude') where.push('deleted = 0');
  if (deleted === 'only') where.push('deleted = 1');
  const sql = `SELECT * FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at_ms DESC, id DESC LIMIT ?`;
  return { items: db.prepare(sql).all(...args, limit).map((row) => postShape(db, row)), next_cursor: null };
}

function workShape(db, row) {
  const parts = db
    .prepare('SELECT * FROM posts WHERE service = ? AND thread_key = ? ORDER BY created_at_ms ASC, id ASC')
    .all(row.service, row.thread_key ?? row.service_post_key)
    .map((part) => postShape(db, part));
  return {
    thread_key: row.thread_key ?? row.service_post_key,
    root_post_id: parts[0]?.id ?? row.id,
    parts,
    media: parts.flatMap((part, partIndex) => part.media.map((m) => ({ part_index: partIndex, ...m }))),
    description: parts.map((part) => ({ post_id: part.id, text: part.text, created_at_ms: part.created_at_ms, url: part.url })),
    credits: [],
    suggestions: null,
    missing_parts: 0,
    quoted: row.quoted_key ? [{ key: row.quoted_key, post: null }] : [],
  };
}

async function serveFile(req, res, db, archiveRoot, sha256) {
  const row = db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256);
  if (!row) return error(res, 404, 'not_found', 'file not found');
  const fullPath = path.join(archiveRoot, row.relpath);
  const info = await stat(fullPath).catch(() => null);
  if (!info) return error(res, 404, 'not_found', 'file missing');
  res.writeHead(200, {
    'content-type': row.mime || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  createReadStream(fullPath).pipe(res);
}

async function uploadFile(req, res, db, archiveRoot, sha256, maxBytes) {
  const bytes = await readBytes(req, maxBytes);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) return error(res, 409, 'conflict', 'hash mismatch');
  const relpath = path.join('_uploads', sha256);
  const fullPath = path.join(archiveRoot, relpath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  db.prepare(`
    INSERT OR IGNORE INTO files (sha256, relpath, bytes, mime, ingested_at, verified_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sha256, relpath, bytes.length, null, Date.now(), Date.now());
  json(res, 200, { ok: true });
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
        return json(res, 200, {
          posts: stats.posts,
          media: stats.media,
          files: stats.files,
          accounts: stats.accounts,
          personas: db.prepare('SELECT COUNT(*) AS n FROM personas').get().n,
          tags: stats.tags,
          by_service: Object.fromEntries(db.prepare('SELECT service, COUNT(*) AS posts FROM posts GROUP BY service').all().map((r) => [r.service, { posts: r.posts }])),
          deleted: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE deleted = 1').get().n,
          db_bytes: 0,
          archive_bytes: 0,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/relation-types') {
        const items = db.prepare('SELECT service, key, label, value_kind, value_meta_json FROM relation_types ORDER BY service, key').all()
          .map((r) => ({ service: r.service, key: r.key, label: r.label, value_kind: r.value_kind, value_meta: r.value_meta_json ? JSON.parse(r.value_meta_json) : null }));
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') return json(res, 200, listPosts(db, url));
      if (req.method === 'GET' && url.pathname === '/api/works') {
        const roots = db.prepare('SELECT * FROM posts GROUP BY service, thread_key ORDER BY created_at_ms DESC, id DESC LIMIT ?').all(Math.min(Number(url.searchParams.get('limit') ?? 60), 200));
        return json(res, 200, { items: roots.map((row) => workShape(db, row)), next_cursor: null });
      }
      const postMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);
      if (req.method === 'GET' && postMatch) {
        const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(postMatch[1]));
        return row ? json(res, 200, postShape(db, row)) : error(res, 404, 'not_found', 'post not found');
      }
      const workMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
      if (req.method === 'GET' && workMatch) {
        const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(workMatch[1]));
        return row ? json(res, 200, workShape(db, row)) : error(res, 404, 'not_found', 'work not found');
      }
      const mediaMatch = url.pathname.match(/^\/api\/media\/(\d+)$/);
      if (req.method === 'GET' && mediaMatch) {
        const row = db.prepare('SELECT * FROM media_items WHERE id = ?').get(Number(mediaMatch[1]));
        if (!row) return error(res, 404, 'not_found', 'media not found');
        const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(row.post_id);
        return json(res, 200, { ...mediaRows(db, row.post_id).find((m) => m.id === row.id), post: postShape(db, post) });
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const items = db.prepare('SELECT * FROM accounts ORDER BY last_seen_at DESC, id DESC LIMIT 200').all().map((row) => ({ ...accountRef(db, row), posts_n: 0, names_n: 0 }));
        return json(res, 200, { items, next_cursor: null });
      }
      if (req.method === 'GET' && url.pathname === '/api/personas') return json(res, 200, { items: [] });
      if (req.method === 'GET' && url.pathname === '/api/tags') return json(res, 200, { items: db.prepare('SELECT name, 0 AS uses FROM tags ORDER BY name').all() });
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
        return json(res, 200, { credits: creditsFor(db, creditsMatch[1], Number(creditsMatch[2])), suggestions: [] });
      }
      if (creditsMatch && req.method === 'PUT') {
        const body = await readJson(req);
        return json(res, 200, { credits: setCredits(db, creditsMatch[1], Number(creditsMatch[2]), body.credits) });
      }

      if (req.method === 'POST' && url.pathname === '/api/ingest/post') {
        const body = await readJson(req);
        const result = await ingest.ingestPost(body, async () => null);
        return json(res, 200, { ok: true, post_id: result.post_id, missing_files: result.missing_files });
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

import Database from 'better-sqlite3';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  service TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relation_types (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL REFERENCES services(service),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK(value_kind IN ('flag','tier','scalar')),
  value_meta_json TEXT,
  UNIQUE(service, key)
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL REFERENCES services(service),
  service_account_id TEXT NOT NULL,
  is_me INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('active','deleted','suspended','unknown')),
  status_observed_at INTEGER,
  first_seen_at INTEGER,
  last_seen_at INTEGER,
  UNIQUE(service, service_account_id)
);
CREATE TABLE IF NOT EXISTS account_names (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('screen_name','display_name')),
  value TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  UNIQUE(account_id, kind, value)
);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS persona_accounts (
  persona_id INTEGER NOT NULL REFERENCES personas(id),
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL REFERENCES services(service),
  service_post_key TEXT NOT NULL,
  author_account_id INTEGER REFERENCES accounts(id),
  created_at_ms INTEGER,
  text TEXT,
  lang TEXT,
  url TEXT,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_detected_at INTEGER,
  counts_json TEXT,
  raw_json TEXT,
  reply_to_key TEXT,
  reply_to_author_id TEXT,
  quoted_key TEXT,
  thread_key TEXT,
  first_ingested_at INTEGER NOT NULL,
  last_ingested_at INTEGER NOT NULL,
  UNIQUE(service, service_post_key)
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_account_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(service, thread_key);
CREATE TABLE IF NOT EXISTS post_versions (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  service_version_id TEXT NOT NULL,
  captured_at_ms INTEGER,
  raw_json TEXT,
  UNIQUE(post_id, service_version_id)
);
CREATE TABLE IF NOT EXISTS files (
  sha256 TEXT PRIMARY KEY,
  relpath TEXT NOT NULL,
  bytes INTEGER,
  mime TEXT,
  ingested_at INTEGER,
  verified_at INTEGER
);
CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  position INTEGER NOT NULL,
  type TEXT,
  sha256 TEXT REFERENCES files(sha256),
  source_url TEXT,
  alt_text TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  UNIQUE(post_id, position)
);
CREATE INDEX IF NOT EXISTS idx_media_post ON media_items(post_id);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  relation_type_id INTEGER NOT NULL REFERENCES relation_types(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('post','media')),
  item_id INTEGER NOT NULL,
  value TEXT,
  observed_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(relation_type_id, account_id, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_item ON relations(item_kind, item_id);
CREATE TABLE IF NOT EXISTS credit_roles (
  role TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY,
  item_kind TEXT NOT NULL CHECK(item_kind IN ('post','media')),
  item_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL REFERENCES credit_roles(role),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','accepted_suggestion')),
  created_at INTEGER NOT NULL,
  UNIQUE(item_kind, item_id, account_id, role)
);
CREATE INDEX IF NOT EXISTS idx_credits_account ON credits(account_id);
CREATE INDEX IF NOT EXISTS idx_credits_item ON credits(item_kind, item_id);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS tag_items (
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('post','media')),
  item_id INTEGER NOT NULL,
  tagged_at INTEGER NOT NULL,
  UNIQUE(tag_id, item_kind, item_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  post_id UNINDEXED, text, alt_text, author_names
);
CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  source TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  posts_n INTEGER,
  files_n INTEGER,
  notes TEXT
);
`;

const SERVICE_SEEDS = [
  ['twitter', 'Twitter/X'],
  ['archivist', 'Archivist'],
];
const RELATION_SEEDS = [
  ['twitter', 'like', 'Like', 'flag', null],
  ['twitter', 'bookmark', 'Bookmark', 'flag', null],
  ['archivist', 'favorite', 'Favorite', 'flag', null],
  ['archivist', 'rating', 'Rating', 'scalar', JSON.stringify({ min: 1, max: 5 })],
];
const CREDIT_ROLE_SEEDS = [
  ['creator', 'Creator'],
  ['subject', 'Subject'],
  ['commissioner', 'Commissioner'],
  ['collaborator', 'Collaborator'],
];

export function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version === 0) {
    db.exec(SCHEMA);
    db.pragma('user_version = 1');
  }
}

function seed(db) {
  const insertService = db.prepare('INSERT OR IGNORE INTO services (service, label) VALUES (?, ?)');
  for (const row of SERVICE_SEEDS) insertService.run(...row);
  const insertRelation = db.prepare(`
    INSERT OR IGNORE INTO relation_types (service, key, label, value_kind, value_meta_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of RELATION_SEEDS) insertRelation.run(...row);
  const insertRole = db.prepare('INSERT OR IGNORE INTO credit_roles (role, label) VALUES (?, ?)');
  for (const row of CREDIT_ROLE_SEEDS) insertRole.run(...row);
  const account = upsertAccount(db, {
    service: 'archivist',
    service_account_id: 'me',
    screen_name: 'me',
    display_name: 'Me',
    status: 'active',
    is_me: 1,
    observed_at: Date.now(),
  });
  db.prepare('UPDATE accounts SET is_me = 1, status = ? WHERE id = ?').run('active', account.id);
}

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  seed(db);
  return createLibrary(db);
}

export function upsertAccount(db, account) {
  const now = account.observed_at ?? Date.now();
  const serviceAccountId = account.service_account_id ?? `~${account.screen_name ?? 'unknown'}`;
  db.prepare(`
    INSERT INTO accounts (service, service_account_id, is_me, status, status_observed_at, first_seen_at, last_seen_at)
    VALUES (@service, @service_account_id, @is_me, @status, @observed_at, @observed_at, @observed_at)
    ON CONFLICT(service, service_account_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      status = CASE WHEN excluded.status != 'unknown' THEN excluded.status ELSE accounts.status END,
      status_observed_at = COALESCE(excluded.status_observed_at, accounts.status_observed_at),
      is_me = MAX(accounts.is_me, excluded.is_me)
  `).run({
    service: account.service,
    service_account_id: serviceAccountId,
    is_me: account.is_me ? 1 : 0,
    status: account.status ?? 'unknown',
    observed_at: now,
  });
  const row = db.prepare('SELECT * FROM accounts WHERE service = ? AND service_account_id = ?').get(account.service, serviceAccountId);
  const upsertName = db.prepare(`
    INSERT INTO account_names (account_id, kind, value, first_observed_at, last_observed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, kind, value) DO UPDATE SET last_observed_at = excluded.last_observed_at
  `);
  if (account.screen_name) upsertName.run(row.id, 'screen_name', account.screen_name, now, now);
  if (account.display_name) upsertName.run(row.id, 'display_name', account.display_name, now, now);
  return row;
}

function createLibrary(db) {
  return {
    raw: db,
    stats() {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      return {
        services: count('services'),
        accounts: count('accounts'),
        posts: count('posts'),
        versions: count('post_versions'),
        media: count('media_items'),
        files: count('files'),
        relations: count('relations'),
        tags: count('tags'),
      };
    },
    close() {
      db.close();
    },
  };
}

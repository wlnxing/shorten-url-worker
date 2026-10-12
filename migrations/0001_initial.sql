CREATE TABLE links (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  target TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX links_active_slug ON links(slug) WHERE deleted_at IS NULL;
CREATE INDEX links_created ON links(created_at DESC, id);

-- AUTOINCREMENT preserves event identity even after all old events are removed.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT NOT NULL,
  city TEXT NOT NULL,
  referer TEXT NOT NULL,
  ua TEXT NOT NULL,
  browser TEXT NOT NULL,
  device TEXT NOT NULL,
  visitor_key TEXT
);
CREATE INDEX events_time ON events(occurred_at, id);
CREATE INDEX events_link_time ON events(link_id, occurred_at, id);

CREATE TABLE archive_days (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading', 'published', 'cleaned', 'deleting')),
  cursor_time INTEGER NOT NULL DEFAULT 0,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  part_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE archive_parts (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  part INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready')),
  first_time INTEGER NOT NULL,
  first_id INTEGER NOT NULL,
  last_time INTEGER NOT NULL,
  last_id INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE INDEX archive_parts_day ON archive_parts(day, part);
CREATE TABLE maintenance (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  token TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_success_at INTEGER,
  last_action TEXT,
  last_error TEXT
);
INSERT INTO maintenance(id) VALUES (1);

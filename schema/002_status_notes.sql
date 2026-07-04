ALTER TABLE potential_sites ADD COLUMN status TEXT NOT NULL DEFAULT 'idea';
ALTER TABLE potential_sites ADD COLUMN submitted_by TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS potential_site_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES potential_sites(id),
  note TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notes_site ON potential_site_notes(site_id, created_at);

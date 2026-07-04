ALTER TABLE potential_sites ADD COLUMN contact TEXT NOT NULL DEFAULT '';
ALTER TABLE potential_sites ADD COLUMN power TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE potential_sites ADD COLUMN access TEXT NOT NULL DEFAULT 'unknown';

PRAGMA foreign_keys = ON;

-- Manual order keys. Everything starts at 0, so untouched libraries keep the previous
-- name / last-modified order and only a drag writes real keys.
ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX notes_order ON notes(user_id, deleted_at, archived, pinned, position, updated_at, id);

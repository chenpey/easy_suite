PRAGMA foreign_keys = ON;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- COALESCE because SQLite treats NULLs as distinct, and root folders all have parent_id NULL.
CREATE UNIQUE INDEX folders_unique_sibling ON folders(user_id, COALESCE(parent_id, ''), name);

-- Folder deletion is guarded by the API; cascading account deletion must not
-- temporarily merge multiple blank notes into the root's unique blank slot.
ALTER TABLE notes ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;
CREATE INDEX notes_folder ON notes(user_id, folder_id, deleted_at);

-- One reusable blank note per (user, folder) instead of per user, so a blank note
-- created inside a folder is never reused from another folder.
DROP INDEX notes_one_blank;
CREATE UNIQUE INDEX notes_one_blank ON notes(user_id, COALESCE(folder_id, ''))
  WHERE title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL;

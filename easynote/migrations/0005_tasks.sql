-- Task pages include active and archived notes in one modification-time order.
CREATE INDEX notes_tasks ON notes(user_id, updated_at DESC, id) WHERE deleted_at IS NULL;

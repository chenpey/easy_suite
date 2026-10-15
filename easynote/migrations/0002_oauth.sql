CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('read', 'read-write')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
ALTER TABLE integration_tokens ADD COLUMN client_id TEXT;
ALTER TABLE integration_tokens ADD COLUMN access_expires_at INTEGER;
ALTER TABLE integration_tokens ADD COLUMN refresh_hash TEXT;
ALTER TABLE integration_tokens ADD COLUMN prev_refresh_hash TEXT;
CREATE UNIQUE INDEX integration_tokens_refresh ON integration_tokens(refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE INDEX integration_tokens_prev_refresh ON integration_tokens(prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;

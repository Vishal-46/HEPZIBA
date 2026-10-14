-- 005_session_tokens: refresh-token rotation + access-token denylist.
-- Idempotent (safe to re-run). Required for POST /auth/refresh and POST /auth/logout.
-- No extensions needed (bigserial keys, no pgcrypto).

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_hash TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- Access-token kill-switch: logout writes the access JWT's jti here until its exp.
-- roleAuth rejects any Bearer whose jti is listed and unexpired.
CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  jti TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_access_expires ON revoked_access_tokens(expires_at);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX user_sessions_user_id_idx
  ON user_sessions(user_id, expires_at DESC);

CREATE INDEX user_sessions_active_token_idx
  ON user_sessions(token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX user_sessions_expiration_idx
  ON user_sessions(expires_at)
  WHERE revoked_at IS NULL;

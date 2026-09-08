import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

type Metadata = {
  ipAddress: string | null;
  userAgent: string | null;
};

export async function listSessions(userId: string, currentSessionId: string) {
  const result = await pool.query<{
    id: string;
    expires_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
  }>(
    `SELECT id, expires_at, last_seen_at, revoked_at, ip_address::text, user_agent, created_at
     FROM user_sessions
     WHERE user_id = $1
       AND expires_at > now() - interval '30 days'
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    active: row.revoked_at === null && row.expires_at > new Date(),
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
}

export async function revokeOwnSession(
  userId: string,
  sessionId: string,
  metadata: Metadata
): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `UPDATE user_sessions
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [sessionId, userId]
  );
  if (!result.rows[0]) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found.');

  await pool.query(
    `INSERT INTO audit_log (
       actor_user_id, action, resource_type, resource_id, ip_address, user_agent
     ) VALUES ($1, 'auth.session.revoked', 'user_session', $2, $3, $4)`,
    [userId, sessionId, metadata.ipAddress, metadata.userAgent?.slice(0, 1000) ?? null]
  );
}

export async function revokeOtherSessions(
  userId: string,
  currentSessionId: string,
  metadata: Metadata
): Promise<number> {
  const result = await pool.query(
    `UPDATE user_sessions
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE user_id = $1
       AND id <> $2
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [userId, currentSessionId]
  );

  await pool.query(
    `INSERT INTO audit_log (
       actor_user_id, action, resource_type, resource_id, metadata, ip_address, user_agent
     ) VALUES ($1, 'auth.sessions.revoked_others', 'user', $1, $2::jsonb, $3, $4)`,
    [userId, JSON.stringify({ count: result.rowCount ?? 0 }), metadata.ipAddress, metadata.userAgent?.slice(0, 1000) ?? null]
  );

  return result.rowCount ?? 0;
}

export async function cleanupSessions(): Promise<{ sessions: number; resetTokens: number; rateLimits: number }> {
  const [sessions, resetTokens, rateLimits] = await Promise.all([
    pool.query(`DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`),
    pool.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days' OR consumed_at < now() - interval '7 days'`),
    pool.query(`DELETE FROM rate_limit_counters WHERE reset_at < now() - interval '1 day'`),
  ]);

  return {
    sessions: sessions.rowCount ?? 0,
    resetTokens: resetTokens.rowCount ?? 0,
    rateLimits: rateLimits.rowCount ?? 0,
  };
}

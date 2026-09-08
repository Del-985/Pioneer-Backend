import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { hashPassword, verifyPassword } from './password.js';

type Metadata = {
  ipAddress: string | null;
  userAgent: string | null;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionId: string,
  metadata: Metadata
): Promise<void> {
  const result = await pool.query<{ password_hash: string | null }>(
    'SELECT password_hash FROM users WHERE id = $1 AND status = \'active\'',
    [userId]
  );
  const passwordHash = result.rows[0]?.password_hash;
  if (!passwordHash || !(await verifyPassword(currentPassword, passwordHash))) {
    throw new HttpError(400, 'CURRENT_PASSWORD_INVALID', 'The current password is incorrect.');
  }

  const nextHash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, nextHash]);
    await client.query(
      `UPDATE user_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, currentSessionId]
    );
    await client.query(
      `UPDATE password_reset_tokens
       SET consumed_at = COALESCE(consumed_at, now())
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [userId]
    );
    await client.query(
      `INSERT INTO audit_log (
         actor_user_id, action, resource_type, resource_id, ip_address, user_agent
       ) VALUES ($1, 'auth.password.changed', 'user', $1, $2, $3)`,
      [userId, metadata.ipAddress, metadata.userAgent?.slice(0, 1000) ?? null]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function requestPasswordReset(email: string, metadata: Metadata): Promise<void> {
  const userResult = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email = $1 AND status = 'active'`,
    [email]
  );
  const user = userResult.rows[0];
  if (!user) return;

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE password_reset_tokens
       SET consumed_at = COALESCE(consumed_at, now())
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [user.id]
    );
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [user.id, tokenHash, expiresAt, metadata.ipAddress]
    );
    await client.query(
      `INSERT INTO notification_outbox (
         channel, recipient, template_key, subject, payload
       ) VALUES ('email', $1, 'password_reset', 'Reset your Pioneer password', $2::jsonb)`,
      [user.email, JSON.stringify({ resetToken: token, expiresAt: expiresAt.toISOString() })]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resetPassword(token: string, newPassword: string, metadata: Metadata): Promise<void> {
  const tokenHash = hashToken(token);
  const nextHash = await hashPassword(newPassword);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const tokenResult = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM password_reset_tokens
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       FOR UPDATE`,
      [tokenHash]
    );
    const reset = tokenResult.rows[0];
    if (!reset) {
      throw new HttpError(400, 'RESET_TOKEN_INVALID', 'The password reset token is invalid or expired.');
    }

    await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND status = \'active\'', [reset.user_id, nextHash]);
    await client.query('UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1', [reset.id]);
    await client.query(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [reset.user_id]
    );
    await client.query(
      `INSERT INTO audit_log (
         actor_user_id, action, resource_type, resource_id, ip_address, user_agent
       ) VALUES ($1, 'auth.password.reset', 'user', $1, $2, $3)`,
      [reset.user_id, metadata.ipAddress, metadata.userAgent?.slice(0, 1000) ?? null]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

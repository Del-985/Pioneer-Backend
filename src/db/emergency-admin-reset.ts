import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { hashPassword } from '../modules/auth/password.js';
import { pool } from './pool.js';

export async function applyEmergencyAdminReset(): Promise<boolean> {
  const email = env.ADMIN_RESET_EMAIL;
  const password = env.ADMIN_RESET_PASSWORD;
  const nonce = env.ADMIN_RESET_NONCE;

  if (!email || !password || !nonce) return false;

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const priorReset = await client.query(
      `SELECT 1
       FROM audit_log
       WHERE action = 'auth.password.emergency_reset'
         AND metadata->>'nonce' = $1
       LIMIT 1`,
      [nonce]
    );

    if ((priorReset.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return false;
    }

    const userResult = await client.query<{ id: string }>(
      `SELECT id
       FROM users
       WHERE email = $1 AND status = 'active'
       FOR UPDATE`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) throw new Error('Emergency admin reset target account was not found or is not active.');

    await client.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
      [user.id, passwordHash]
    );
    await client.query(
      `UPDATE user_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    );
    await client.query(
      `UPDATE password_reset_tokens
       SET consumed_at = COALESCE(consumed_at, now())
       WHERE user_id = $1 AND consumed_at IS NULL`,
      [user.id]
    );
    await client.query(
      `INSERT INTO audit_log (
         actor_user_id, action, resource_type, resource_id, metadata
       ) VALUES ($1, 'auth.password.emergency_reset', 'user', $1, $2::jsonb)`,
      [user.id, JSON.stringify({ nonce })]
    );

    await client.query('COMMIT');
    logger.warn({ email }, 'One-time emergency administrator password reset applied');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

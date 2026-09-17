import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { pool } from './pool.js';
import { hashPassword } from '../modules/auth/password.js';

async function bootstrapAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  const displayName = env.BOOTSTRAP_ADMIN_NAME;
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  const forceReset = process.env.BOOTSTRAP_ADMIN_FORCE_RESET === 'true';

  if (!email || !displayName || !password) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME, and BOOTSTRAP_ADMIN_PASSWORD are required.'
    );
  }

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (email)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = CASE WHEN $4::boolean THEN EXCLUDED.password_hash ELSE users.password_hash END,
         status = 'active',
         updated_at = now()
       RETURNING id`,
      [email, displayName, passwordHash, forceReset]
    );

    const user = userResult.rows[0];
    if (!user) throw new Error('Failed to create bootstrap administrator.');

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE key = 'platform_admin'`
    );
    const role = roleResult.rows[0];
    if (!role) throw new Error('platform_admin role does not exist. Run migrations first.');

    await client.query(
      `INSERT INTO user_role_assignments (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [user.id, role.id]
    );

    if (forceReset) {
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
        `INSERT INTO audit_log (actor_user_id, action, resource_type, resource_id)
         VALUES ($1, 'auth.password.recovery_reset', 'user', $1)`,
        [user.id]
      );
    }

    await client.query('COMMIT');
    logger.info(
      { email, forceReset },
      forceReset
        ? 'Platform administrator recovery password reset applied'
        : 'Platform administrator bootstrapped without replacing existing credentials'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrapAdmin().catch((error) => {
  logger.fatal({ err: error }, 'Administrator bootstrap failed');
  process.exit(1);
});

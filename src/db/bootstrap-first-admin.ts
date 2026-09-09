import { randomBytes } from 'node:crypto';
import { logger } from '../config/logger.js';
import { hashPassword } from '../modules/auth/password.js';
import { pool } from './pool.js';

const ADMIN_EMAIL = 'admin@pioneerlegacyworks.com';
const ADMIN_NAME = 'Platform Administrator';

async function main() {
  const existing = await pool.query('SELECT 1 FROM users LIMIT 1');
  if (existing.rows[0]) {
    logger.info('Initial administrator bootstrap skipped because a user already exists');
    await pool.end();
    return;
  }

  const temporaryPassword = `${randomBytes(24).toString('base64url')}!Aa1`;
  const passwordHash = await hashPassword(temporaryPassword);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');

    const lockedExisting = await client.query('SELECT 1 FROM users LIMIT 1');
    if (lockedExisting.rows[0]) {
      await client.query('ROLLBACK');
      logger.info('Initial administrator bootstrap skipped because another process created a user');
      return;
    }

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE key = 'platform_admin'`
    );
    const role = roleResult.rows[0];
    if (!role) throw new Error('platform_admin role does not exist.');

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [ADMIN_EMAIL, ADMIN_NAME, passwordHash]
    );
    const user = userResult.rows[0];
    if (!user) throw new Error('Initial platform administrator could not be created.');

    await client.query(
      `INSERT INTO user_role_assignments (user_id, role_id)
       VALUES ($1, $2)`,
      [user.id, role.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'platform.bootstrap_admin.created', 'user', $1, $2::jsonb)`,
      [user.id, JSON.stringify({ email: ADMIN_EMAIL, bootstrapMethod: 'one_time_runtime' })]
    );

    await client.query('COMMIT');
    logger.warn(
      { email: ADMIN_EMAIL, temporaryPassword },
      'BOOTSTRAP_TEMP_PASSWORD: initial platform administrator created; change password after first login'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Initial administrator bootstrap failed');
  await pool.end().catch(() => undefined);
  process.exit(1);
});

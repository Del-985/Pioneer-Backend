import { logger } from '../config/logger.js';
import { pool } from './pool.js';
import { cleanupSessions } from '../modules/auth/session.service.js';

async function main() {
  const result = await cleanupSessions();
  const customerSessions = await pool.query(
    `DELETE FROM customer_portal_sessions
     WHERE expires_at <= now() OR revoked_at IS NOT NULL`
  );
  const idempotency = await pool.query(
    `DELETE FROM bookkeeping_idempotency_keys WHERE expires_at <= now()`
  );
  logger.info(
    {
      ...result,
      customerPortalSessions: customerSessions.rowCount ?? 0,
      bookkeepingIdempotencyKeys: idempotency.rowCount ?? 0,
    },
    'Expired authentication/rate-limit/idempotency records cleaned'
  );
  await pool.end();
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Session cleanup failed');
  await pool.end();
  process.exit(1);
});

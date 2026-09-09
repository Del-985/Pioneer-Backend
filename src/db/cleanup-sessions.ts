import { logger } from '../config/logger.js';
import { pool } from './pool.js';
import { cleanupSessions } from '../modules/auth/session.service.js';

async function main() {
  const result = await cleanupSessions();
  const idempotency = await pool.query(
    `DELETE FROM bookkeeping_idempotency_keys WHERE expires_at <= now()`
  );
  logger.info(
    { ...result, bookkeepingIdempotencyKeys: idempotency.rowCount ?? 0 },
    'Expired authentication/rate-limit/idempotency records cleaned'
  );
  await pool.end();
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Session cleanup failed');
  await pool.end();
  process.exit(1);
});

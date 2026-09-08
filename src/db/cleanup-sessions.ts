import { logger } from '../config/logger.js';
import { pool } from './pool.js';
import { cleanupSessions } from '../modules/auth/session.service.js';

async function main() {
  const result = await cleanupSessions();
  logger.info(result, 'Expired authentication/rate-limit records cleaned');
  await pool.end();
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Session cleanup failed');
  await pool.end();
  process.exit(1);
});

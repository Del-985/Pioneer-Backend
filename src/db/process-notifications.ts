import { logger } from '../config/logger.js';
import { pool } from './pool.js';
import { processEmailNotifications } from '../modules/notifications/notification-delivery.service.js';

async function main() {
  const result = await processEmailNotifications();
  logger.info(result, 'Notification delivery batch completed');
  await pool.end();
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Notification delivery failed');
  await pool.end();
  process.exit(1);
});

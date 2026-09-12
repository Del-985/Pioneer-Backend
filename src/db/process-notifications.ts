import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  processEmailNotifications,
  processSmsNotifications,
} from '../modules/notifications/notification-delivery.service.js';
import { pool } from './pool.js';

async function main() {
  const sms = await processSmsNotifications();
  const emailConfigured = Boolean(
    env.SMTP_HOST &&
    env.SMTP_FROM &&
    env.SMTP_USER &&
    env.SMTP_PASSWORD
  );
  const email = emailConfigured
    ? await processEmailNotifications()
    : { claimed: 0, sent: 0, failed: 0 };

  logger.info({ sms, email }, 'Notification delivery batch completed');
  await pool.end();
}

main().catch(async (error) => {
  logger.fatal({ err: error }, 'Notification delivery failed');
  await pool.end();
  process.exit(1);
});

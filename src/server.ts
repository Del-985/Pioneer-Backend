import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import {
  processEmailNotifications,
  processSmsNotifications,
} from './modules/notifications/notification-delivery.service.js';

async function start(): Promise<void> {
  await pool.query('SELECT 1');

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Pioneer Backend listening');
  });

  const emailDeliveryEnabled = Boolean(
    env.SMTP_HOST &&
    env.SMTP_FROM &&
    env.SMTP_USER &&
    env.SMTP_PASSWORD
  );
  const smsDeliveryEnabled = Boolean(env.TEXTBEE_API_KEY);
  const notificationDeliveryEnabled = emailDeliveryEnabled || smsDeliveryEnabled;
  let notificationRunInFlight = false;

  const processNotificationBatch = async (): Promise<void> => {
    if (!notificationDeliveryEnabled || notificationRunInFlight) return;
    notificationRunInFlight = true;
    try {
      // Process SMS first so a text-preference notification can fall back to email
      // and be picked up by the email worker in the same delivery cycle.
      const sms = await processSmsNotifications();
      const email = emailDeliveryEnabled
        ? await processEmailNotifications()
        : { claimed: 0, sent: 0, failed: 0 };

      if (sms.claimed > 0 || email.claimed > 0) {
        logger.info({ sms, email }, 'Scheduled notification delivery batch completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Scheduled notification delivery batch failed');
    } finally {
      notificationRunInFlight = false;
    }
  };

  if (notificationDeliveryEnabled) {
    void processNotificationBatch();
  }
  if (!emailDeliveryEnabled) {
    logger.warn('Authenticated SMTP is not configured; email notifications will remain queued until SMTP_HOST, SMTP_FROM, SMTP_USER, and SMTP_PASSWORD are configured.');
  }
  if (!smsDeliveryEnabled) {
    logger.warn('TextBee SMS is not configured; customer text-preference notifications will fall back to email when an email address is available.');
  }

  const notificationTimer = setInterval(() => void processNotificationBatch(), 30_000);
  notificationTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown requested');
    clearInterval(notificationTimer);

    server.close(async () => {
      await pool.end();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch(async (error) => {
  logger.fatal({ err: error }, 'Failed to start Pioneer Backend');
  await pool.end();
  process.exit(1);
});

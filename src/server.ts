import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';
import { processEmailNotifications } from './modules/notifications/notification-delivery.service.js';

async function start(): Promise<void> {
  await pool.query('SELECT 1');

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Pioneer Backend listening');
  });

  const emailDeliveryEnabled = Boolean(env.SMTP_HOST && env.SMTP_FROM);
  let notificationRunInFlight = false;

  const processNotificationBatch = async (): Promise<void> => {
    if (!emailDeliveryEnabled || notificationRunInFlight) return;
    notificationRunInFlight = true;
    try {
      const result = await processEmailNotifications();
      if (result.claimed > 0) {
        logger.info(result, 'Scheduled notification delivery batch completed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Scheduled notification delivery batch failed');
    } finally {
      notificationRunInFlight = false;
    }
  };

  if (emailDeliveryEnabled) {
    void processNotificationBatch();
  } else {
    logger.warn('SMTP is not configured; email notifications will remain queued until SMTP is configured.');
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

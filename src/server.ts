import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { pool } from './db/pool.js';

async function start(): Promise<void> {
  await pool.query('SELECT 1');

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Pioneer Backend listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown requested');

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

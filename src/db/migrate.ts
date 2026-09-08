import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from './pool.js';
import { logger } from '../config/logger.js';

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.join(process.cwd(), 'migrations');
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const appliedResult = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations'
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const filename of files) {
      if (applied.has(filename)) continue;

      const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
      logger.info({ filename }, 'Applying migration');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    logger.info('Database migrations complete');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  logger.fatal({ err: error }, 'Database migration failed');
  process.exit(1);
});

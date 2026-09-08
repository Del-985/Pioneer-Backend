import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from 'express-rate-limit';
import { pool } from '../db/pool.js';

export class PostgresRateLimitStore implements Store {
  windowMs = 60_000;
  prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const result = await pool.query<{ hits: string; reset_at: Date }>(
      `INSERT INTO rate_limit_counters (bucket_key, hits, reset_at)
       VALUES ($1, 1, now() + ($2::bigint * interval '1 millisecond'))
       ON CONFLICT (bucket_key)
       DO UPDATE SET
         hits = CASE
           WHEN rate_limit_counters.reset_at <= now() THEN 1
           ELSE rate_limit_counters.hits + 1
         END,
         reset_at = CASE
           WHEN rate_limit_counters.reset_at <= now()
             THEN now() + ($2::bigint * interval '1 millisecond')
           ELSE rate_limit_counters.reset_at
         END,
         updated_at = now()
       RETURNING hits::text, reset_at`,
      [this.key(key), this.windowMs]
    );

    const row = result.rows[0];
    if (!row) throw new Error('Rate limit counter could not be incremented.');
    return { totalHits: Number(row.hits), resetTime: row.reset_at };
  }

  async decrement(key: string): Promise<void> {
    await pool.query(
      `UPDATE rate_limit_counters
       SET hits = GREATEST(hits - 1, 0), updated_at = now()
       WHERE bucket_key = $1 AND reset_at > now()`,
      [this.key(key)]
    );
  }

  async resetKey(key: string): Promise<void> {
    await pool.query('DELETE FROM rate_limit_counters WHERE bucket_key = $1', [this.key(key)]);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const result = await pool.query<{ hits: string; reset_at: Date }>(
      `SELECT hits::text, reset_at
       FROM rate_limit_counters
       WHERE bucket_key = $1 AND reset_at > now()`,
      [this.key(key)]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { totalHits: Number(row.hits), resetTime: row.reset_at };
  }

  async resetAll(): Promise<void> {
    await pool.query('DELETE FROM rate_limit_counters WHERE bucket_key LIKE $1', [`${this.prefix}:%`]);
  }
}

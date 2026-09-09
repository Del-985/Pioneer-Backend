import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function requestHash(payload: unknown) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function normalizeIdempotencyKey(raw: string | undefined) {
  if (!raw) return null;
  const key = raw.trim();
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be between 8 and 200 characters.');
  }
  return key;
}

type StoredRow = {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  expires_at: Date;
};

export async function runIdempotent<T>(input: {
  userId: string;
  operation: string;
  key: string | null;
  payload: unknown;
  successStatus?: number;
  execute: () => Promise<T>;
}): Promise<{ value: T; status: number; replayed: boolean }> {
  const status = input.successStatus ?? 200;
  if (!input.key) {
    return { value: await input.execute(), status, replayed: false };
  }

  const hash = requestHash(input.payload);
  const inserted = await pool.query(
    `INSERT INTO bookkeeping_idempotency_keys (user_id, operation, idempotency_key, request_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.userId, input.operation, input.key, hash]
  );

  if (!inserted.rows[0]) {
    const existing = await pool.query<StoredRow>(
      `SELECT request_hash, response_status, response_body, expires_at
       FROM bookkeeping_idempotency_keys
       WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [input.userId, input.operation, input.key]
    );
    const row = existing.rows[0];
    if (!row) {
      throw new HttpError(409, 'IDEMPOTENCY_RACE', 'The idempotent operation could not be resolved. Retry the request.');
    }
    if (row.expires_at.getTime() <= Date.now()) {
      await pool.query(
        `DELETE FROM bookkeeping_idempotency_keys
         WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3 AND expires_at <= now()`,
        [input.userId, input.operation, input.key]
      );
      return runIdempotent(input);
    }
    if (row.request_hash !== hash) {
      throw new HttpError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request payload.'
      );
    }
    if (row.response_status !== null && row.response_body !== null) {
      return { value: row.response_body as T, status: row.response_status, replayed: true };
    }
    throw new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'An operation with this Idempotency-Key is already in progress.');
  }

  try {
    const value = await input.execute();
    await pool.query(
      `UPDATE bookkeeping_idempotency_keys
       SET response_status=$4, response_body=$5::jsonb
       WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3`,
      [input.userId, input.operation, input.key, status, JSON.stringify(value)]
    );
    return { value, status, replayed: false };
  } catch (error) {
    await pool.query(
      `DELETE FROM bookkeeping_idempotency_keys
       WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3 AND response_status IS NULL`,
      [input.userId, input.operation, input.key]
    );
    throw error;
  }
}

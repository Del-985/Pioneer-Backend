import { HttpError } from './http-error.js';

type PgErrorLike = {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
};

function isPgError(error: unknown): error is PgErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export function mapDatabaseError(error: unknown): HttpError | null {
  if (!isPgError(error) || typeof error.code !== 'string') return null;

  const details = {
    constraint: error.constraint ?? null,
    table: error.table ?? null,
    column: error.column ?? null,
  };

  switch (error.code) {
    case '23505':
      return new HttpError(409, 'CONFLICT', 'A record with the same unique value already exists.', details);
    case '23503':
      return new HttpError(409, 'REFERENCE_CONFLICT', 'This operation conflicts with a related record.', details);
    case '23514':
    case '23502':
    case '22P02':
      return new HttpError(400, 'DATABASE_VALIDATION_ERROR', 'The request violates a data constraint.', details);
    case '40001':
    case '40P01':
      return new HttpError(409, 'TRANSACTION_CONFLICT', 'The operation conflicted with another transaction. Retry the request.');
    default:
      return null;
  }
}

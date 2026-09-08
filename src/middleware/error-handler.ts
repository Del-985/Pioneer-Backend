import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { HttpError } from '../lib/http-error.js';
import { mapDatabaseError } from '../lib/pg-error.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route exists for ${req.method} ${req.originalUrl}`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request contains invalid data.',
        details: error.flatten(),
      },
    });
    return;
  }

  const httpError = error instanceof HttpError ? error : mapDatabaseError(error);
  if (httpError) {
    if (httpError.statusCode >= 500) {
      logger.error({ err: error, method: req.method, url: req.originalUrl }, 'Request failed');
    }

    res.status(httpError.statusCode).json({
      error: {
        code: httpError.code,
        message: httpError.message,
        ...(httpError.details === undefined ? {} : { details: httpError.details }),
      },
    });
    return;
  }

  logger.error(
    { err: error, method: req.method, url: req.originalUrl },
    'Unhandled request error'
  );

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
};

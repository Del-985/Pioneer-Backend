import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../config/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route exists for ${req.method} ${req.originalUrl}`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error({ err: error }, 'Unhandled request error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    },
  });
};

import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Session cookies and bearer credentials must never be written to
  // application logs, even when pino-http serializes the full request headers.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["proxy-authorization"]',
      'req.headers["x-employee-session"]',
    ],
    censor: '[REDACTED]',
  },
  base: {
    service: 'pioneer-backend',
    environment: env.NODE_ENV,
  },
});

import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { HttpError } from '../lib/http-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireTrustedMutationOrigin: RequestHandler = (req, _res, next) => {
  try {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');

    if (origin) {
      if (!env.corsOrigins.includes(origin)) {
        throw new HttpError(403, 'UNTRUSTED_ORIGIN', 'The request origin is not allowed to perform state-changing operations.');
      }
      next();
      return;
    }

    // Non-browser clients commonly omit both Origin and Fetch Metadata headers.
    // Browsers sending Fetch Metadata without Origin on a mutation are rejected.
    if (fetchSite) {
      throw new HttpError(403, 'ORIGIN_REQUIRED', 'A trusted Origin header is required for browser mutations.');
    }

    next();
  } catch (error) {
    next(error);
  }
};

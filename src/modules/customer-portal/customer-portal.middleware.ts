import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http-error.js';
import { authenticateCustomerSessionToken } from './customer-auth.service.js';

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const [rawName, ...rawValueParts] = part.trim().split('=');
    if (rawName !== name) continue;

    const rawValue = rawValueParts.join('=');
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}

export const requireCustomerAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = readCookie(req.headers.cookie, env.CUSTOMER_SESSION_COOKIE_NAME);
    if (!token) {
      throw new HttpError(401, 'CUSTOMER_UNAUTHENTICATED', 'Customer authentication is required.');
    }

    req.customerAuth = await authenticateCustomerSessionToken(token);
    next();
  } catch (error) {
    next(error);
  }
};

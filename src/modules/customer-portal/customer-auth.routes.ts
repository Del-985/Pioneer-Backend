import type { CookieOptions, Request } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { PostgresRateLimitStore } from '../../lib/postgres-rate-limit-store.js';
import { requireCustomerAuth } from './customer-portal.middleware.js';
import { customerLoginSchema, customerRegisterSchema } from './customer-portal.schemas.js';
import {
  loginCustomerAccount,
  registerCustomerAccount,
  revokeCustomerSession,
} from './customer-auth.service.js';

export const customerAuthRouter = Router();

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new PostgresRateLimitStore('customer-auth'),
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many customer authentication attempts. Please try again later.',
    },
  },
});

function cookieOptions(expires?: Date): CookieOptions {
  const isProduction = env.NODE_ENV === 'production';
  const options: CookieOptions & { partitioned?: boolean } = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
    partitioned: isProduction,
  };
  if (expires) options.expires = expires;
  return options;
}

function requestMetadata(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

customerAuthRouter.post('/register', authRateLimiter, async (req, res) => {
  const input = customerRegisterSchema.parse(req.body);
  const session = await registerCustomerAccount(input, requestMetadata(req));
  res.cookie(env.CUSTOMER_SESSION_COOKIE_NAME, session.token, cookieOptions(session.expiresAt));
  res.status(201).json({
    data: {
      user: session.user,
      customer: session.customer,
      expiresAt: session.expiresAt,
    },
  });
});

customerAuthRouter.post('/login', authRateLimiter, async (req, res) => {
  const input = customerLoginSchema.parse(req.body);
  const session = await loginCustomerAccount(input, requestMetadata(req));
  res.cookie(env.CUSTOMER_SESSION_COOKIE_NAME, session.token, cookieOptions(session.expiresAt));
  res.json({
    data: {
      user: session.user,
      customer: session.customer,
      expiresAt: session.expiresAt,
    },
  });
});

customerAuthRouter.post('/logout', requireCustomerAuth, async (req, res) => {
  const auth = req.customerAuth!;
  await revokeCustomerSession(auth.sessionId, auth.accountId);
  res.clearCookie(env.CUSTOMER_SESSION_COOKIE_NAME, cookieOptions());
  res.status(204).end();
});

customerAuthRouter.get('/me', requireCustomerAuth, async (req, res) => {
  const auth = req.customerAuth!;
  res.json({
    data: {
      user: {
        id: auth.accountId,
        email: auth.email,
        displayName: auth.displayName,
      },
      customer: {
        id: auth.customerId,
        businessUnitId: auth.businessUnitId,
        displayName: auth.displayName,
        email: auth.email,
        phone: auth.phone,
        siteKey: auth.siteKey,
      },
    },
  });
});

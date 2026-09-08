import type { CookieOptions } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { createSession, getAccessSummary, revokeSession } from './auth.service.js';
import { loginSchema } from './auth.schemas.js';

export const authRouter = Router();

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Please try again later.',
    },
  },
});

function cookieOptions(expires?: Date): CookieOptions {
  const isProduction = env.NODE_ENV === 'production';
  const options: CookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };

  if (expires) options.expires = expires;
  if (env.SESSION_COOKIE_DOMAIN) options.domain = env.SESSION_COOKIE_DOMAIN;

  return options;
}

authRouter.post('/login', loginRateLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const session = await createSession(input.email, input.password, {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });

  res.cookie(env.SESSION_COOKIE_NAME, session.token, cookieOptions(session.expiresAt));
  res.json({
    data: {
      user: session.user,
      expiresAt: session.expiresAt,
    },
  });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const auth = req.auth!;
  await revokeSession(auth.sessionId, auth.userId, {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });

  res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions());
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const auth = req.auth!;
  const access = await getAccessSummary(auth.userId);

  res.json({
    data: {
      user: {
        id: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
      },
      access,
    },
  });
});

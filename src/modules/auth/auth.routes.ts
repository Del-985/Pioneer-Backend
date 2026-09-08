import type { CookieOptions, Request } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { requireRouteParam } from '../../lib/route-param.js';
import { PostgresRateLimitStore } from '../../lib/postgres-rate-limit-store.js';
import { requireAuth } from '../../middleware/auth.js';
import { createSession, getAccessSummary, revokeSession } from './auth.service.js';
import {
  changePasswordSchema,
  loginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
} from './auth.schemas.js';
import {
  changePassword,
  requestPasswordReset,
  resetPassword,
} from './password-management.service.js';
import {
  listSessions,
  revokeOtherSessions,
  revokeOwnSession,
} from './session.service.js';

export const authRouter = Router();

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new PostgresRateLimitStore('auth-login'),
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Please try again later.',
    },
  },
});

const passwordResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  store: new PostgresRateLimitStore('auth-password-reset'),
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many password reset requests. Please try again later.',
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

function requestMetadata(req: Request) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

authRouter.post('/login', loginRateLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const session = await createSession(input.email, input.password, requestMetadata(req));

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
  await revokeSession(auth.sessionId, auth.userId, requestMetadata(req));

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

authRouter.get('/sessions', requireAuth, async (req, res) => {
  res.json({ data: await listSessions(req.auth!.userId, req.auth!.sessionId) });
});

authRouter.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  const sessionId = requireRouteParam(req, 'sessionId');
  await revokeOwnSession(req.auth!.userId, sessionId, requestMetadata(req));
  if (sessionId === req.auth!.sessionId) {
    res.clearCookie(env.SESSION_COOKIE_NAME, cookieOptions());
  }
  res.status(204).end();
});

authRouter.post('/sessions/revoke-others', requireAuth, async (req, res) => {
  const count = await revokeOtherSessions(
    req.auth!.userId,
    req.auth!.sessionId,
    requestMetadata(req)
  );
  res.json({ data: { revoked: count } });
});

authRouter.post('/password/change', requireAuth, async (req, res) => {
  const input = changePasswordSchema.parse(req.body);
  await changePassword(
    req.auth!.userId,
    input.currentPassword,
    input.newPassword,
    req.auth!.sessionId,
    requestMetadata(req)
  );
  res.status(204).end();
});

authRouter.post('/password/reset/request', passwordResetRateLimiter, async (req, res) => {
  const input = requestPasswordResetSchema.parse(req.body);
  await requestPasswordReset(input.email, requestMetadata(req));
  res.status(202).json({ data: { accepted: true } });
});

authRouter.post('/password/reset', passwordResetRateLimiter, async (req, res) => {
  const input = resetPasswordSchema.parse(req.body);
  await resetPassword(input.token, input.newPassword, requestMetadata(req));
  res.status(204).end();
});

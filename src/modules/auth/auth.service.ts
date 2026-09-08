import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { hashPassword, verifyPassword } from './password.js';

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: 'active' | 'disabled';
};

type SessionRow = {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
};

type AccessRow = {
  role_key: string;
  role_name: string;
  scope: 'platform' | 'legal_entity' | 'business_unit';
  legal_entity_id: string | null;
  business_unit_id: string | null;
  permissions: string[];
};

type SessionMetadata = {
  ipAddress: string | null;
  userAgent: string | null;
};

export type AuthContext = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
};

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidCredentials(): HttpError {
  return new HttpError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
}

export async function createSession(
  email: string,
  password: string,
  metadata: SessionMetadata
) {
  const userResult = await pool.query<UserRow>(
    `SELECT id, email, display_name, password_hash, status
     FROM users
     WHERE email = $1`,
    [email]
  );

  const user = userResult.rows[0];
  if (!user?.password_hash) {
    // Keep failed-login work reasonably similar even when the account does not exist.
    await hashPassword(password);
    throw invalidCredentials();
  }

  const passwordMatches = await verifyPassword(password, user.password_hash);
  if (!passwordMatches || user.status !== 'active') {
    throw invalidCredentials();
  }

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sessionResult = await client.query<{ id: string }>(
      `INSERT INTO user_sessions (
         user_id,
         token_hash,
         expires_at,
         ip_address,
         user_agent
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        user.id,
        tokenHash,
        expiresAt,
        metadata.ipAddress,
        metadata.userAgent?.slice(0, 1000) ?? null,
      ]
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw new HttpError(500, 'SESSION_CREATE_FAILED', 'The session could not be created.');
    }

    await client.query(
      `INSERT INTO audit_log (
         actor_user_id,
         action,
         resource_type,
         resource_id,
         ip_address,
         user_agent
       )
       VALUES ($1, 'auth.login', 'user_session', $2, $3, $4)`,
      [
        user.id,
        session.id,
        metadata.ipAddress,
        metadata.userAgent?.slice(0, 1000) ?? null,
      ]
    );

    await client.query('COMMIT');

    return {
      token,
      expiresAt,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateSessionToken(token: string): Promise<AuthContext> {
  const tokenHash = hashSessionToken(token);
  const result = await pool.query<SessionRow>(
    `SELECT
       s.id,
       u.id AS user_id,
       u.email,
       u.display_name
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'`,
    [tokenHash]
  );

  const session = result.rows[0];
  if (!session) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }

  await pool.query(
    `UPDATE user_sessions
     SET last_seen_at = now()
     WHERE id = $1
       AND last_seen_at < now() - interval '5 minutes'`,
    [session.id]
  );

  return {
    sessionId: session.id,
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
  };
}

export async function revokeSession(
  sessionId: string,
  userId: string,
  metadata: SessionMetadata
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE user_sessions
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1
         AND user_id = $2`,
      [sessionId, userId]
    );

    await client.query(
      `INSERT INTO audit_log (
         actor_user_id,
         action,
         resource_type,
         resource_id,
         ip_address,
         user_agent
       )
       VALUES ($1, 'auth.logout', 'user_session', $2, $3, $4)`,
      [
        userId,
        sessionId,
        metadata.ipAddress,
        metadata.userAgent?.slice(0, 1000) ?? null,
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAccessSummary(userId: string) {
  const result = await pool.query<AccessRow>(
    `SELECT
       r.key AS role_key,
       r.name AS role_name,
       r.scope,
       ura.legal_entity_id,
       ura.business_unit_id,
       ARRAY_AGG(DISTINCT p.key ORDER BY p.key) AS permissions
     FROM user_role_assignments ura
     JOIN roles r ON r.id = ura.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ura.user_id = $1
     GROUP BY
       ura.id,
       r.key,
       r.name,
       r.scope,
       ura.legal_entity_id,
       ura.business_unit_id
     ORDER BY r.scope, r.name`,
    [userId]
  );

  return result.rows.map((assignment) => ({
    role: {
      key: assignment.role_key,
      name: assignment.role_name,
    },
    scope: assignment.scope,
    legalEntityId: assignment.legal_entity_id,
    businessUnitId: assignment.business_unit_id,
    permissions: assignment.permissions,
  }));
}

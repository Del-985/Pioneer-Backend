import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { customerLoginSchema, customerRegisterSchema } from './customer-portal.schemas.js';

type RegisterInput = z.infer<typeof customerRegisterSchema>;
type LoginInput = z.infer<typeof customerLoginSchema>;

type SiteRow = {
  id: string;
  business_unit_id: string;
};

type AccountRow = {
  id: string;
  business_unit_id: string;
  customer_id: string;
  site_id: string;
  email: string;
  password_hash: string;
  status: 'active' | 'disabled';
  site_key: string;
  display_name: string;
  phone: string | null;
  customer_status: 'active' | 'inactive';
};

type SessionRow = {
  session_id: string;
  account_id: string;
  business_unit_id: string;
  customer_id: string;
  site_id: string;
  email: string;
  display_name: string;
  phone: string | null;
  site_key: string;
};

type RequestMetadata = {
  ipAddress: string | null;
  userAgent: string | null;
};

export type CustomerAuthContext = {
  sessionId: string;
  accountId: string;
  businessUnitId: string;
  customerId: string;
  siteId: string;
  siteKey: string;
  email: string;
  displayName: string;
  phone: string | null;
};

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidCredentials(): HttpError {
  return new HttpError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
}

async function resolveBusinessSite(siteKey: string, client: PoolClient): Promise<SiteRow> {
  const result = await client.query<SiteRow>(
    `SELECT id, business_unit_id
     FROM sites
     WHERE key = $1
       AND scope = 'business_unit'
       AND business_unit_id IS NOT NULL
       AND status = 'active'`,
    [siteKey]
  );

  const site = result.rows[0];
  if (!site) {
    throw new HttpError(404, 'CUSTOMER_SITE_NOT_FOUND', 'This customer portal is not available.');
  }
  return site;
}

async function insertSession(
  client: PoolClient,
  accountId: string,
  metadata: RequestMetadata
) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

  const result = await client.query<{ id: string }>(
    `INSERT INTO customer_portal_sessions (
       account_id, token_hash, expires_at, ip_address, user_agent
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [
      accountId,
      tokenHash,
      expiresAt,
      metadata.ipAddress,
      metadata.userAgent?.slice(0, 1000) ?? null,
    ]
  );

  const session = result.rows[0];
  if (!session) {
    throw new HttpError(500, 'CUSTOMER_SESSION_CREATE_FAILED', 'The customer session could not be created.');
  }

  return { token, expiresAt, sessionId: session.id };
}

export async function registerCustomerAccount(input: RegisterInput, metadata: RequestMetadata) {
  const email = normalizedEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const site = await resolveBusinessSite(input.siteKey, client);

    const duplicate = await client.query<{ id: string }>(
      `SELECT id
       FROM customer_portal_accounts
       WHERE business_unit_id = $1 AND email = $2`,
      [site.business_unit_id, email]
    );
    if (duplicate.rows[0]) {
      throw new HttpError(409, 'CUSTOMER_ACCOUNT_EXISTS', 'A customer account already exists for this email.');
    }

    const customerResult = await client.query<{ id: string }>(
      `INSERT INTO customers (
         business_unit_id, display_name, contact_name, email, phone, status
       ) VALUES ($1,$2,$2,$3,$4,'active')
       RETURNING id`,
      [site.business_unit_id, input.displayName, email, input.phone]
    );
    const customer = customerResult.rows[0];
    if (!customer) {
      throw new HttpError(500, 'CUSTOMER_CREATE_FAILED', 'The customer record could not be created.');
    }

    const accountResult = await client.query<{ id: string }>(
      `INSERT INTO customer_portal_accounts (
         business_unit_id, customer_id, site_id, email, password_hash, status
       ) VALUES ($1,$2,$3,$4,$5,'active')
       RETURNING id`,
      [site.business_unit_id, customer.id, site.id, email, passwordHash]
    );
    const account = accountResult.rows[0];
    if (!account) {
      throw new HttpError(500, 'CUSTOMER_ACCOUNT_CREATE_FAILED', 'The customer account could not be created.');
    }

    const session = await insertSession(client, account.id, metadata);
    await client.query('COMMIT');

    return {
      ...session,
      user: {
        id: account.id,
        email,
        displayName: input.displayName,
      },
      customer: {
        id: customer.id,
        businessUnitId: site.business_unit_id,
        displayName: input.displayName,
        email,
        phone: input.phone,
      },
    };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'CUSTOMER_ACCOUNT_EXISTS', 'A customer account already exists for this email.');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function loginCustomerAccount(input: LoginInput, metadata: RequestMetadata) {
  const email = normalizedEmail(input.email);
  const result = await pool.query<AccountRow>(
    `SELECT
       a.id, a.business_unit_id, a.customer_id, a.site_id, a.email, a.password_hash, a.status,
       s.key AS site_key,
       c.display_name, c.phone, c.status AS customer_status
     FROM customer_portal_accounts a
     JOIN sites s ON s.id = a.site_id AND s.status = 'active'
     JOIN customers c ON c.id = a.customer_id
     WHERE a.email = $1
       AND ($2::text IS NULL OR s.key = $2)
     ORDER BY a.created_at ASC
     LIMIT 2`,
    [email, input.siteKey ?? null]
  );

  if (result.rows.length !== 1) {
    await hashPassword(input.password);
    throw invalidCredentials();
  }

  const account = result.rows[0]!;
  const matches = await verifyPassword(input.password, account.password_hash);
  if (!matches || account.status !== 'active' || account.customer_status !== 'active') {
    throw invalidCredentials();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await insertSession(client, account.id, metadata);
    await client.query('COMMIT');

    return {
      ...session,
      user: {
        id: account.id,
        email: account.email,
        displayName: account.display_name,
      },
      customer: {
        id: account.customer_id,
        businessUnitId: account.business_unit_id,
        displayName: account.display_name,
        email: account.email,
        phone: account.phone,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateCustomerSessionToken(token: string): Promise<CustomerAuthContext> {
  const result = await pool.query<SessionRow>(
    `SELECT
       ps.id AS session_id,
       a.id AS account_id,
       a.business_unit_id,
       a.customer_id,
       a.site_id,
       a.email,
       c.display_name,
       c.phone,
       s.key AS site_key
     FROM customer_portal_sessions ps
     JOIN customer_portal_accounts a ON a.id = ps.account_id
     JOIN customers c ON c.id = a.customer_id
     JOIN sites s ON s.id = a.site_id
     WHERE ps.token_hash = $1
       AND ps.revoked_at IS NULL
       AND ps.expires_at > now()
       AND a.status = 'active'
       AND c.status = 'active'
       AND s.status = 'active'`,
    [hashSessionToken(token)]
  );

  const row = result.rows[0];
  if (!row) {
    throw new HttpError(401, 'CUSTOMER_UNAUTHENTICATED', 'Customer authentication is required.');
  }

  await pool.query(
    `UPDATE customer_portal_sessions
     SET last_seen_at = now()
     WHERE id = $1
       AND last_seen_at < now() - interval '5 minutes'`,
    [row.session_id]
  );

  return {
    sessionId: row.session_id,
    accountId: row.account_id,
    businessUnitId: row.business_unit_id,
    customerId: row.customer_id,
    siteId: row.site_id,
    siteKey: row.site_key,
    email: row.email,
    displayName: row.display_name,
    phone: row.phone,
  };
}

export async function revokeCustomerSession(sessionId: string, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE customer_portal_sessions
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND account_id = $2`,
    [sessionId, accountId]
  );
}

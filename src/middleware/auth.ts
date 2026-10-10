import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { pool } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import { authenticateSessionToken } from '../modules/auth/auth.service.js';
import { env } from '../config/env.js';

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

function getSessionToken(req: Request): string | null {
  return readCookie(req.headers.cookie, env.SESSION_COOKIE_NAME);
}

// The employee frontend lives on a different registrable domain from the API.
// Safari can reject its third-party cookie even when POST /auth/login succeeds.
// A bearer token is therefore allowed *only* on the employee portal routes,
// never on the Admin, Books, customer or platform routes.
export function isTrustedEmployeePortalOrigin(origin: string | undefined): boolean {
  if (origin === 'https://employee.pioneeroutdoorservices.com') return true;
  if (env.NODE_ENV === 'production') return false;
  return origin === 'http://localhost:5173' ||
    origin === 'http://127.0.0.1:5173' ||
    origin === 'http://127.0.0.1:4173' ||
    origin === 'http://localhost:4173';
}

export const requireEmployeePortalAuth: RequestHandler = async (req, res, next) => {
  const header = req.get('authorization');
  if (!header) {
    // Keep the existing HTTP-only cookie mechanism compatible for browsers
    // that already accept it.
    requireAuth(req, res, next);
    return;
  }
  try {
    if (!isTrustedEmployeePortalOrigin(req.get('origin'))) {
      throw new HttpError(403, 'EMPLOYEE_SESSION_ORIGIN_DENIED',
        'Employee session access is restricted to the secure employee portal.');
    }
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) {
      throw new HttpError(401, 'INVALID_EMPLOYEE_SESSION',
        'This employee session is missing or invalid.');
    }
    req.auth = await authenticateSessionToken(match[1]!);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = getSessionToken(req);
    if (!token) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
    }

    req.auth = await authenticateSessionToken(token);
    next();
  } catch (error) {
    next(error);
  }
};

export function requireSitePermission(permissionKey: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
      }

      const siteKey = req.params.siteKey;
      if (!siteKey) {
        throw new HttpError(400, 'SITE_CONTEXT_REQUIRED', 'A site context is required.');
      }

      const result = await pool.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM sites s
           LEFT JOIN business_units site_bu ON site_bu.id = s.business_unit_id
           JOIN user_role_assignments ura ON ura.user_id = $1
           JOIN roles r ON r.id = ura.role_id
           JOIN role_permissions rp ON rp.role_id = r.id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE s.key = $2
             AND p.key = $3
             AND (
               (
                 r.scope = 'platform'
                 AND ura.legal_entity_id IS NULL
                 AND ura.business_unit_id IS NULL
               )
               OR (
                 s.scope = 'legal_entity'
                 AND r.scope = 'legal_entity'
                 AND ura.legal_entity_id = s.legal_entity_id
               )
               OR (
                 s.scope = 'business_unit'
                 AND (
                   (
                     r.scope = 'business_unit'
                     AND ura.business_unit_id = s.business_unit_id
                   )
                   OR (
                     r.scope = 'legal_entity'
                     AND ura.legal_entity_id = site_bu.legal_entity_id
                   )
                 )
               )
             )
         ) AS allowed`,
        [req.auth.userId, siteKey, permissionKey]
      );

      if (!result.rows[0]?.allowed) {
        throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

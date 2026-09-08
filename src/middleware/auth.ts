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

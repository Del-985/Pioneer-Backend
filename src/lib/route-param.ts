import type { Request } from 'express';
import { HttpError } from './http-error.js';

export function requireRouteParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'INVALID_ROUTE_PARAMETER', `Route parameter ${name} is required.`);
  }
  return value;
}

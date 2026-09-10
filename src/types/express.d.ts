import type { AuthContext } from '../modules/auth/auth.service.js';
import type { CustomerAuthContext } from '../modules/customer-portal/customer-auth.service.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      customerAuth?: CustomerAuthContext;
    }
  }
}

export {};

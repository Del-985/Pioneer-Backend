import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { adminSiteRouter } from '../modules/sites/admin-site.routes.js';
import { publicSiteRouter } from '../modules/sites/public-site.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/public/sites', publicSiteRouter);
apiRouter.use('/admin/sites', adminSiteRouter);

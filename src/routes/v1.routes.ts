import { Router } from 'express';
import { authRouter } from '../modules/auth/auth.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { adminSiteRouter } from '../modules/sites/admin-site.routes.js';
import { publicSiteRouter } from '../modules/sites/public-site.routes.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/public/sites', publicSiteRouter);
v1Router.use('/admin/sites', adminSiteRouter);

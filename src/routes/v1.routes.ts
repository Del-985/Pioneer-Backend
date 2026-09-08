import { Router } from 'express';
import { healthRouter } from '../modules/health/health.routes.js';
import { publicSiteRouter } from '../modules/sites/public-site.routes.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/public/sites', publicSiteRouter);

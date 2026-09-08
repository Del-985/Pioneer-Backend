import { Router } from 'express';
import { adminAccessRouter } from '../modules/access/admin-access.routes.js';
import { adminOverviewRouter } from '../modules/admin/admin-overview.routes.js';
import { adminAuditRouter } from '../modules/audit/admin-audit.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';
import { adminBusinessUnitRouter } from '../modules/business-units/admin-business-unit.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { adminLegalEntityRouter } from '../modules/legal-entities/admin-legal-entity.routes.js';
import { adminSiteRouter } from '../modules/sites/admin-site.routes.js';
import { publicSiteRouter } from '../modules/sites/public-site.routes.js';
import { adminUserRouter } from '../modules/users/admin-user.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/public/sites', publicSiteRouter);

apiRouter.use('/admin/overview', adminOverviewRouter);
apiRouter.use('/admin/access', adminAccessRouter);
apiRouter.use('/admin/audit', adminAuditRouter);
apiRouter.use('/admin/legal-entities', adminLegalEntityRouter);
apiRouter.use('/admin/business-units', adminBusinessUnitRouter);
apiRouter.use('/admin/users', adminUserRouter);
apiRouter.use('/admin/sites', adminSiteRouter);

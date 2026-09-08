import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireSitePermission } from '../../middleware/auth.js';
import { pageSlugSchema, siteKeySchema } from './public-site.schemas.js';
import {
  businessUnitPublicProfileSchema,
  contactListQuerySchema,
  contactStatusSchema,
  createSitePageSchema,
  sitePageSchema,
  siteProfileSchema,
} from './admin-site.schemas.js';
import {
  createSitePage,
  getAdminSite,
  listBusinessUnitProfiles,
  listContactSubmissions,
  putBusinessUnitProfile,
  putSitePage,
  putSiteProfile,
  updateContactStatus,
} from './admin-site.service.js';

export const adminSiteRouter = Router();
const contactIdSchema = z.string().uuid();

function actorFromRequest(req: Request) {
  return {
    userId: req.auth!.userId,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

adminSiteRouter.get('/:siteKey', requireAuth, requireSitePermission('sites.read'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  res.json({ data: await getAdminSite(siteKey) });
});

adminSiteRouter.put('/:siteKey/profile', requireAuth, requireSitePermission('sites.write'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const input = siteProfileSchema.parse(req.body);
  await putSiteProfile(siteKey, input, actorFromRequest(req));
  res.status(204).end();
});

adminSiteRouter.post('/:siteKey/pages', requireAuth, requireSitePermission('sites.write'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const input = createSitePageSchema.parse(req.body);
  const page = await createSitePage(siteKey, input, actorFromRequest(req));
  res.status(201).json({ data: page });
});

adminSiteRouter.put('/:siteKey/pages/:slug', requireAuth, requireSitePermission('sites.write'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const slug = pageSlugSchema.parse(req.params.slug);
  const input = sitePageSchema.parse(req.body);
  await putSitePage(siteKey, slug, input, actorFromRequest(req));
  res.status(204).end();
});

adminSiteRouter.get('/:siteKey/business-units', requireAuth, requireSitePermission('sites.read'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  res.json({ data: await listBusinessUnitProfiles(siteKey) });
});

adminSiteRouter.put('/:siteKey/business-units/:businessUnitSlug', requireAuth, requireSitePermission('sites.write'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const businessUnitSlug = siteKeySchema.parse(req.params.businessUnitSlug);
  const input = businessUnitPublicProfileSchema.parse(req.body);
  await putBusinessUnitProfile(siteKey, businessUnitSlug, input, actorFromRequest(req));
  res.status(204).end();
});

adminSiteRouter.get('/:siteKey/contacts', requireAuth, requireSitePermission('contacts.read'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const query = contactListQuerySchema.parse(req.query);
  res.json({ data: await listContactSubmissions(siteKey, query) });
});

adminSiteRouter.patch('/:siteKey/contacts/:contactId/status', requireAuth, requireSitePermission('contacts.manage'), async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const contactId = contactIdSchema.parse(req.params.contactId);
  const input = contactStatusSchema.parse(req.body);
  await updateContactStatus(siteKey, contactId, input, actorFromRequest(req));
  res.status(204).end();
});

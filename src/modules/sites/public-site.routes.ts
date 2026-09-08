import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PostgresRateLimitStore } from '../../lib/postgres-rate-limit-store.js';
import {
  pageSlugSchema,
  parseContactSubmission,
  siteKeySchema,
} from './public-site.schemas.js';
import {
  createContactSubmission,
  getPublicPage,
  getPublicSite,
  listPublicBusinessUnits,
} from './public-site.service.js';

export const publicSiteRouter = Router();

const contactRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  store: new PostgresRateLimitStore('public-contact'),
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many contact submissions. Please try again later.',
    },
  },
});

publicSiteRouter.get('/:siteKey', async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const site = await getPublicSite(siteKey);
  res.json({ data: site });
});

publicSiteRouter.get('/:siteKey/pages/:slug', async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const slug = pageSlugSchema.parse(req.params.slug);
  const page = await getPublicPage(siteKey, slug);
  res.json({ data: page });
});

publicSiteRouter.get('/:siteKey/business-units', async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const businessUnits = await listPublicBusinessUnits(siteKey);
  res.json({ data: businessUnits });
});

publicSiteRouter.post('/:siteKey/contact', contactRateLimiter, async (req, res) => {
  const siteKey = siteKeySchema.parse(req.params.siteKey);
  const input = parseContactSubmission(req.body);

  if (input.website) {
    res.status(202).json({ data: { accepted: true } });
    return;
  }

  const submission = await createContactSubmission(siteKey, input, {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });

  res.status(201).json({ data: submission });
});

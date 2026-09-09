import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { PostgresRateLimitStore } from '../../lib/postgres-rate-limit-store.js';
import { processEmailNotifications } from '../notifications/notification-delivery.service.js';
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

const OUTDOOR_SERVICES_SITE_KEY = 'pioneer-outdoor-services';
const OUTDOOR_SERVICES_BUSINESS_UNIT_SLUG = 'pos';
const LEGACY_OUTDOOR_SERVICES_SLUG = 'pioneer-outdoor-services';
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const OUTDOOR_SPAM_PHRASES = [
  'backlink',
  'guest post',
  'link building',
  'rank your website',
  'seo service',
  'search engine optimization',
  'casino',
  'cryptocurrency',
  'crypto investment',
  'viagra',
  'web design service',
  'increase your traffic',
];

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

function normalizeOutdoorServicesSlug(siteKey: string, businessUnitSlug: string | null): string | null {
  if (
    businessUnitSlug === LEGACY_OUTDOOR_SERVICES_SLUG ||
    (siteKey === OUTDOOR_SERVICES_SITE_KEY && !businessUnitSlug)
  ) {
    return OUTDOOR_SERVICES_BUSINESS_UNIT_SLUG;
  }
  return businessUnitSlug;
}

function outdoorServiceSpamReason(input: {
  subject: string | null;
  message: string;
  website: string | null;
}): string | null {
  if (input.website) return 'honeypot';

  const text = `${input.subject ?? ''}\n${input.message}`.toLowerCase();
  const urlCount = text.match(URL_PATTERN)?.length ?? 0;
  const containsSolicitationPhrase = OUTDOOR_SPAM_PHRASES.some((phrase) => text.includes(phrase));

  if (urlCount >= 3) return 'excessive_links';
  if (urlCount >= 1 && containsSolicitationPhrase) return 'irrelevant_solicitation';
  if (/(.)\1{40,}/.test(text)) return 'repeated_character_payload';

  return null;
}

function queueImmediateEmailDelivery(): void {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return;

  void processEmailNotifications(10)
    .then((result) => {
      if (result.claimed > 0) {
        logger.info(result, 'Immediate notification delivery batch completed');
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'Immediate notification delivery batch failed');
    });
}

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
  input.businessUnitSlug = normalizeOutdoorServicesSlug(siteKey, input.businessUnitSlug);

  const isOutdoorServicesRequest =
    siteKey === OUTDOOR_SERVICES_SITE_KEY || input.businessUnitSlug === OUTDOOR_SERVICES_BUSINESS_UNIT_SLUG;

  if (isOutdoorServicesRequest) {
    const spamReason = outdoorServiceSpamReason(input);
    if (spamReason) {
      logger.info({ siteKey, spamReason }, 'Outdoor Services request suppressed by spam filter');
      res.status(202).json({ data: { accepted: true } });
      return;
    }
  } else if (input.website) {
    res.status(202).json({ data: { accepted: true } });
    return;
  }

  const submission = await createContactSubmission(siteKey, input, {
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });

  res.status(201).json({ data: submission });
  queueImmediateEmailDelivery();
});

import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import type { ContactSubmissionInput } from './public-site.schemas.js';

type SiteScope = 'platform' | 'legal_entity' | 'business_unit';

type SiteRow = {
  id: string;
  key: string;
  name: string;
  scope: SiteScope;
  legal_entity_id: string | null;
  business_unit_id: string | null;
  primary_hostname: string | null;
  brand_name: string | null;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  favicon_url: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  social_links: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

type NavigationRow = {
  slug: string;
  title: string;
  navigation_label: string | null;
};

type PageRow = {
  slug: string;
  title: string;
  content: Record<string, unknown>;
  seo_title: string | null;
  seo_description: string | null;
  published_at: Date | null;
  updated_at: Date;
};

type BusinessUnitRow = {
  slug: string;
  public_name: string;
  short_description: string | null;
  website_url: string | null;
  site_key: string | null;
  primary_hostname: string | null;
};

type ContactResultRow = {
  id: string;
  created_at: Date;
};

type ResolvedBusinessUnitRow = {
  id: string;
  legal_entity_id: string;
  is_published: boolean;
};

type ContactRequestMetadata = {
  ipAddress: string | null;
  userAgent: string | null;
};

async function requireActiveSite(siteKey: string): Promise<SiteRow> {
  const result = await pool.query<SiteRow>(
    `SELECT
       s.id,
       s.key,
       s.name,
       s.scope,
       s.legal_entity_id,
       s.business_unit_id,
       s.primary_hostname,
       sp.brand_name,
       sp.tagline,
       sp.description,
       sp.logo_url,
       sp.favicon_url,
       sp.contact_email,
       sp.contact_phone,
       sp.social_links,
       sp.metadata
     FROM sites s
     LEFT JOIN site_profiles sp ON sp.site_id = s.id
     WHERE s.key = $1
       AND s.status = 'active'`,
    [siteKey]
  );

  const site = result.rows[0];
  if (!site) {
    throw new HttpError(404, 'SITE_NOT_FOUND', 'The requested site does not exist.');
  }

  return site;
}

export async function getPublicSite(siteKey: string) {
  const site = await requireActiveSite(siteKey);

  const navigationResult = await pool.query<NavigationRow>(
    `SELECT slug, title, navigation_label
     FROM site_pages
     WHERE site_id = $1
       AND status = 'published'
       AND show_in_navigation = true
       AND (published_at IS NULL OR published_at <= now())
     ORDER BY navigation_order ASC, title ASC`,
    [site.id]
  );

  return {
    key: site.key,
    name: site.name,
    scope: site.scope,
    primaryHostname: site.primary_hostname,
    profile: {
      brandName: site.brand_name ?? site.name,
      tagline: site.tagline,
      description: site.description,
      logoUrl: site.logo_url,
      faviconUrl: site.favicon_url,
      contactEmail: site.contact_email,
      contactPhone: site.contact_phone,
      socialLinks: site.social_links ?? {},
      metadata: site.metadata ?? {},
    },
    navigation: navigationResult.rows.map((page) => ({
      slug: page.slug,
      title: page.title,
      label: page.navigation_label ?? page.title,
    })),
  };
}

export async function getPublicPage(siteKey: string, slug: string) {
  const site = await requireActiveSite(siteKey);

  const result = await pool.query<PageRow>(
    `SELECT slug, title, content, seo_title, seo_description, published_at, updated_at
     FROM site_pages
     WHERE site_id = $1
       AND slug = $2
       AND status = 'published'
       AND (published_at IS NULL OR published_at <= now())`,
    [site.id, slug]
  );

  const page = result.rows[0];
  if (!page) {
    throw new HttpError(404, 'PAGE_NOT_FOUND', 'The requested page does not exist.');
  }

  return {
    slug: page.slug,
    title: page.title,
    content: page.content,
    seo: {
      title: page.seo_title,
      description: page.seo_description,
    },
    publishedAt: page.published_at,
    updatedAt: page.updated_at,
  };
}

export async function listPublicBusinessUnits(siteKey: string) {
  await requireActiveSite(siteKey);

  const result = await pool.query<BusinessUnitRow>(
    `SELECT
       bu.slug,
       bp.public_name,
       bp.short_description,
       bp.website_url,
       child_site.key AS site_key,
       child_site.primary_hostname
     FROM business_units bu
     JOIN legal_entities le
       ON le.id = bu.legal_entity_id
      AND le.status = 'active'
     JOIN business_unit_public_profiles bp
       ON bp.business_unit_id = bu.id
      AND bp.is_published = true
     LEFT JOIN sites child_site
       ON child_site.business_unit_id = bu.id
      AND child_site.status = 'active'
     WHERE bu.status = 'active'
     ORDER BY bp.sort_order ASC, bp.public_name ASC`,
  );

  return result.rows.map((unit) => ({
    slug: unit.slug,
    name: unit.public_name,
    description: unit.short_description,
    websiteUrl: unit.website_url,
    siteKey: unit.site_key,
    primaryHostname: unit.primary_hostname,
  }));
}

async function resolveRequestedBusinessUnit(
  site: SiteRow,
  businessUnitSlug: string | null
): Promise<string | null> {
  if (!businessUnitSlug) {
    return site.scope === 'business_unit' ? site.business_unit_id : null;
  }

  const result = await pool.query<ResolvedBusinessUnitRow>(
    `SELECT
       bu.id,
       bu.legal_entity_id,
       COALESCE(bp.is_published, false) AS is_published
     FROM business_units bu
     LEFT JOIN business_unit_public_profiles bp
       ON bp.business_unit_id = bu.id
     WHERE bu.slug = $1
       AND bu.status = 'active'`,
    [businessUnitSlug]
  );

  const businessUnit = result.rows[0];
  if (!businessUnit) {
    throw new HttpError(400, 'INVALID_BUSINESS_UNIT', 'The selected business unit is not available.');
  }

  if (site.scope === 'business_unit' && site.business_unit_id !== businessUnit.id) {
    throw new HttpError(400, 'BUSINESS_UNIT_SCOPE_MISMATCH', 'The selected business unit does not belong to this site.');
  }

  if (site.scope === 'legal_entity' && site.legal_entity_id !== businessUnit.legal_entity_id) {
    throw new HttpError(400, 'BUSINESS_UNIT_SCOPE_MISMATCH', 'The selected business unit does not belong to this site.');
  }

  if (site.scope !== 'business_unit' && !businessUnit.is_published) {
    throw new HttpError(400, 'INVALID_BUSINESS_UNIT', 'The selected business unit is not publicly available.');
  }

  return businessUnit.id;
}

export async function createContactSubmission(
  siteKey: string,
  input: ContactSubmissionInput,
  requestMetadata: ContactRequestMetadata
) {
  const site = await requireActiveSite(siteKey);
  const requestedBusinessUnitId = await resolveRequestedBusinessUnit(
    site,
    input.businessUnitSlug
  );

  const result = await pool.query<ContactResultRow>(
    `INSERT INTO contact_submissions (
       site_id,
       requested_business_unit_id,
       name,
       email,
       phone,
       subject,
       message,
       source_path,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      site.id,
      requestedBusinessUnitId,
      input.name,
      input.email,
      input.phone,
      input.subject,
      input.message,
      input.sourcePath,
      requestMetadata.ipAddress,
      requestMetadata.userAgent?.slice(0, 1000) ?? null,
    ]
  );

  const submission = result.rows[0];
  if (!submission) {
    throw new HttpError(500, 'CONTACT_SUBMISSION_FAILED', 'The contact submission could not be saved.');
  }

  return {
    id: submission.id,
    receivedAt: submission.created_at,
  };
}

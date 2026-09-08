import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import {
  businessUnitPublicProfileSchema,
  contactListQuerySchema,
  contactStatusSchema,
  createSitePageSchema,
  sitePageSchema,
  siteProfileSchema,
} from './admin-site.schemas.js';

type SiteProfileInput = z.infer<typeof siteProfileSchema>;
type CreatePageInput = z.infer<typeof createSitePageSchema>;
type PageInput = z.infer<typeof sitePageSchema>;
type BusinessUnitProfileInput = z.infer<typeof businessUnitPublicProfileSchema>;
type ContactListQuery = z.infer<typeof contactListQuerySchema>;
type ContactStatusInput = z.infer<typeof contactStatusSchema>;

type ActorMetadata = {
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
};

type SiteScopeRow = {
  id: string;
  key: string;
  scope: 'platform' | 'legal_entity' | 'business_unit';
  legal_entity_id: string | null;
  business_unit_id: string | null;
};

async function requireSite(siteKey: string): Promise<SiteScopeRow> {
  const result = await pool.query<SiteScopeRow>(
    `SELECT id, key, scope, legal_entity_id, business_unit_id
     FROM sites
     WHERE key = $1`,
    [siteKey]
  );

  const site = result.rows[0];
  if (!site) throw new HttpError(404, 'SITE_NOT_FOUND', 'The requested site does not exist.');
  return site;
}

async function writeAudit(
  client: PoolClient,
  actor: ActorMetadata,
  site: SiteScopeRow,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (
       actor_user_id,
       legal_entity_id,
       business_unit_id,
       action,
       resource_type,
       resource_id,
       metadata,
       ip_address,
       user_agent
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      actor.userId,
      site.legal_entity_id,
      site.business_unit_id,
      action,
      resourceType,
      resourceId,
      metadata,
      actor.ipAddress,
      actor.userAgent?.slice(0, 1000) ?? null,
    ]
  );
}

export async function getAdminSite(siteKey: string) {
  const site = await requireSite(siteKey);

  const [profileResult, pageResult] = await Promise.all([
    pool.query(
      `SELECT brand_name, tagline, description, logo_url, favicon_url,
              contact_email, contact_phone, social_links, metadata
       FROM site_profiles
       WHERE site_id = $1`,
      [site.id]
    ),
    pool.query(
      `SELECT slug, title, navigation_label, show_in_navigation, navigation_order,
              content, seo_title, seo_description, status, published_at,
              created_at, updated_at
       FROM site_pages
       WHERE site_id = $1
       ORDER BY navigation_order ASC, title ASC`,
      [site.id]
    ),
  ]);

  const profile = profileResult.rows[0] ?? null;

  return {
    site: {
      key: site.key,
      scope: site.scope,
    },
    profile: profile ? {
      brandName: profile.brand_name,
      tagline: profile.tagline,
      description: profile.description,
      logoUrl: profile.logo_url,
      faviconUrl: profile.favicon_url,
      contactEmail: profile.contact_email,
      contactPhone: profile.contact_phone,
      socialLinks: profile.social_links,
      metadata: profile.metadata,
    } : null,
    pages: pageResult.rows.map((page) => ({
      slug: page.slug,
      title: page.title,
      navigationLabel: page.navigation_label,
      showInNavigation: page.show_in_navigation,
      navigationOrder: page.navigation_order,
      content: page.content,
      seoTitle: page.seo_title,
      seoDescription: page.seo_description,
      status: page.status,
      publishedAt: page.published_at,
      createdAt: page.created_at,
      updatedAt: page.updated_at,
    })),
  };
}

export async function putSiteProfile(
  siteKey: string,
  input: SiteProfileInput,
  actor: ActorMetadata
) {
  const site = await requireSite(siteKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO site_profiles (
         site_id, brand_name, tagline, description, logo_url, favicon_url,
         contact_email, contact_phone, social_links, metadata
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (site_id)
       DO UPDATE SET
         brand_name = EXCLUDED.brand_name,
         tagline = EXCLUDED.tagline,
         description = EXCLUDED.description,
         logo_url = EXCLUDED.logo_url,
         favicon_url = EXCLUDED.favicon_url,
         contact_email = EXCLUDED.contact_email,
         contact_phone = EXCLUDED.contact_phone,
         social_links = EXCLUDED.social_links,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        site.id,
        input.brandName,
        input.tagline,
        input.description,
        input.logoUrl,
        input.faviconUrl,
        input.contactEmail,
        input.contactPhone,
        input.socialLinks,
        input.metadata,
      ]
    );

    await writeAudit(client, actor, site, 'site.profile.update', 'site', site.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createSitePage(
  siteKey: string,
  input: CreatePageInput,
  actor: ActorMetadata
) {
  const site = await requireSite(siteKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
      `INSERT INTO site_pages (
         site_id, slug, title, navigation_label, show_in_navigation,
         navigation_order, content, seo_title, seo_description, status, published_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        site.id,
        input.slug,
        input.title,
        input.navigationLabel,
        input.showInNavigation,
        input.navigationOrder,
        input.content,
        input.seoTitle,
        input.seoDescription,
        input.status,
        input.publishedAt ? new Date(input.publishedAt) : null,
      ]
    );

    const pageId = result.rows[0]?.id;
    if (!pageId) throw new HttpError(500, 'PAGE_CREATE_FAILED', 'The page could not be created.');

    await writeAudit(client, actor, site, 'site.page.create', 'site_page', pageId, { slug: input.slug });
    await client.query('COMMIT');
    return { id: pageId, slug: input.slug };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function putSitePage(
  siteKey: string,
  slug: string,
  input: PageInput,
  actor: ActorMetadata
) {
  const site = await requireSite(siteKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
      `UPDATE site_pages
       SET title = $3,
           navigation_label = $4,
           show_in_navigation = $5,
           navigation_order = $6,
           content = $7,
           seo_title = $8,
           seo_description = $9,
           status = $10,
           published_at = $11,
           updated_at = now()
       WHERE site_id = $1
         AND slug = $2
       RETURNING id`,
      [
        site.id,
        slug,
        input.title,
        input.navigationLabel,
        input.showInNavigation,
        input.navigationOrder,
        input.content,
        input.seoTitle,
        input.seoDescription,
        input.status,
        input.publishedAt ? new Date(input.publishedAt) : null,
      ]
    );

    const pageId = result.rows[0]?.id;
    if (!pageId) throw new HttpError(404, 'PAGE_NOT_FOUND', 'The requested page does not exist.');

    await writeAudit(client, actor, site, 'site.page.update', 'site_page', pageId, { slug });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listBusinessUnitProfiles(siteKey: string) {
  const site = await requireSite(siteKey);
  const result = await pool.query(
    `SELECT
       bu.slug,
       bu.name,
       bu.status,
       bp.public_name,
       bp.short_description,
       bp.website_url,
       bp.sort_order,
       COALESCE(bp.is_published, false) AS is_published
     FROM business_units bu
     LEFT JOIN business_unit_public_profiles bp ON bp.business_unit_id = bu.id
     WHERE
       $1::text = 'platform'
       OR ($1::text = 'legal_entity' AND bu.legal_entity_id = $2::uuid)
       OR ($1::text = 'business_unit' AND bu.id = $3::uuid)
     ORDER BY COALESCE(bp.sort_order, 0), COALESCE(bp.public_name, bu.name)`,
    [site.scope, site.legal_entity_id, site.business_unit_id]
  );

  return result.rows.map((row) => ({
    slug: row.slug,
    internalName: row.name,
    status: row.status,
    publicName: row.public_name,
    shortDescription: row.short_description,
    websiteUrl: row.website_url,
    sortOrder: row.sort_order ?? 0,
    isPublished: row.is_published,
  }));
}

export async function putBusinessUnitProfile(
  siteKey: string,
  businessUnitSlug: string,
  input: BusinessUnitProfileInput,
  actor: ActorMetadata
) {
  const site = await requireSite(siteKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const unitResult = await client.query<{ id: string; legal_entity_id: string }>(
      `SELECT id, legal_entity_id
       FROM business_units
       WHERE slug = $1`,
      [businessUnitSlug]
    );
    const unit = unitResult.rows[0];
    if (!unit) throw new HttpError(404, 'BUSINESS_UNIT_NOT_FOUND', 'The business unit does not exist.');

    const inScope = site.scope === 'platform'
      || (site.scope === 'legal_entity' && site.legal_entity_id === unit.legal_entity_id)
      || (site.scope === 'business_unit' && site.business_unit_id === unit.id);
    if (!inScope) throw new HttpError(403, 'BUSINESS_UNIT_SCOPE_MISMATCH', 'The business unit is outside this site scope.');

    await client.query(
      `INSERT INTO business_unit_public_profiles (
         business_unit_id, public_name, short_description, website_url, sort_order, is_published
       )
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (business_unit_id)
       DO UPDATE SET
         public_name = EXCLUDED.public_name,
         short_description = EXCLUDED.short_description,
         website_url = EXCLUDED.website_url,
         sort_order = EXCLUDED.sort_order,
         is_published = EXCLUDED.is_published,
         updated_at = now()`,
      [unit.id, input.publicName, input.shortDescription, input.websiteUrl, input.sortOrder, input.isPublished]
    );

    await writeAudit(client, actor, site, 'site.business_unit_profile.update', 'business_unit', unit.id, {
      slug: businessUnitSlug,
      isPublished: input.isPublished,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listContactSubmissions(siteKey: string, query: ContactListQuery) {
  const site = await requireSite(siteKey);
  const values: unknown[] = [site.id, query.limit, query.offset];
  let statusClause = '';

  if (query.status) {
    values.push(query.status);
    statusClause = 'AND c.status = $4';
  }

  const result = await pool.query(
    `SELECT
       c.id, c.name, c.email, c.phone, c.subject, c.message, c.source_path,
       c.status, c.created_at, c.updated_at, bu.slug AS business_unit_slug,
       bu.name AS business_unit_name
     FROM contact_submissions c
     LEFT JOIN business_units bu ON bu.id = c.requested_business_unit_id
     WHERE c.site_id = $1
       ${statusClause}
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    values
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    subject: row.subject,
    message: row.message,
    sourcePath: row.source_path,
    status: row.status,
    businessUnit: row.business_unit_slug ? {
      slug: row.business_unit_slug,
      name: row.business_unit_name,
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function updateContactStatus(
  siteKey: string,
  contactId: string,
  input: ContactStatusInput,
  actor: ActorMetadata
) {
  const site = await requireSite(siteKey);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string }>(
      `UPDATE contact_submissions
       SET status = $3, updated_at = now()
       WHERE site_id = $1
         AND id = $2
       RETURNING id`,
      [site.id, contactId, input.status]
    );

    if (!result.rows[0]) throw new HttpError(404, 'CONTACT_NOT_FOUND', 'The contact submission does not exist.');

    await writeAudit(client, actor, site, 'contact.status.update', 'contact_submission', contactId, {
      status: input.status,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

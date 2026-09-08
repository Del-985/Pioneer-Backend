# Parent Site Backend

The Pioneer Legacy Works parent website uses the shared Pioneer Backend rather than maintaining its own API or database.

The parent site is registered as the platform-scoped site key `pioneer-legacy-works`.

## Public API

All public parent-site routes are below `/api/public/sites`.

### `GET /pioneer-legacy-works`

Returns the public site manifest, including branding/profile data and the current published navigation entries.

### `GET /pioneer-legacy-works/pages/:slug`

Returns a single published page. Draft, archived, and future-scheduled pages are not returned publicly.

Page bodies are stored as structured JSON so the frontend can render reusable section/component types without the backend becoming coupled to HTML.

### `GET /pioneer-legacy-works/business-units`

Returns active business units that have been explicitly published to the public directory. Internal or inactive business units are not exposed.

### `POST /pioneer-legacy-works/contact`

Accepts public contact requests and stores them centrally for later administration/workflow handling.

Example body:

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "419-555-0100",
  "subject": "General inquiry",
  "message": "I would like more information.",
  "businessUnitSlug": "pioneer-outdoor-services",
  "sourcePath": "/contact",
  "website": ""
}
```

At least one of `email` or `phone` is required. `website` is a honeypot field and should remain empty in the frontend form.

Contact submissions are rate-limited per backend instance. If the platform later runs multiple backend instances, the limiter store should be moved to a shared datastore such as Redis or PostgreSQL so limits are enforced across every instance.

## Data model

The website layer adds these tables:

- `sites`: registers public websites and their organizational scope.
- `site_profiles`: public branding and company/contact metadata.
- `site_pages`: structured, publishable page content and navigation metadata.
- `business_unit_public_profiles`: controls which business units appear publicly and their marketing summary.
- `contact_submissions`: centralized website inquiries, optionally routed to a business unit.

A site can be scoped to the whole platform, one legal entity, or one business unit. The parent site uses platform scope. Future division websites can therefore reuse the same API module without creating another backend.

## Authentication API

Authentication routes are below `/api/auth`:

- `POST /login`
- `POST /logout`
- `GET /me`

Authentication uses revocable server-side sessions.

## Administrative API

Protected parent-site administration routes are below `/api/admin/sites/:siteKey` and cover site/profile management, page publishing, public business-unit profiles, contact review, and contact status updates.

Administrative access is enforced using the shared platform role/permission system and the organizational scope of the site.

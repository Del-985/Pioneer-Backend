# Pioneer Backend

Shared backend platform for Pioneer Legacy Works and its business units, websites, bookkeeping tools, admin systems, and future applications.

## Architectural rules

- One backend API serves every Pioneer-owned frontend and application.
- `LegalEntity` represents an actual legal/tax entity.
- `BusinessUnit` represents an operating division or brand and always belongs to a `LegalEntity`.
- Authorization and business/entity isolation are enforced by the backend, never only by frontend filters.
- Users are platform identities. Access to business data is granted through scoped role assignments.
- `All Businesses` is a reporting concern; it does not bypass entity isolation for mutations.
- Public application routes live under the stable `/api` namespace without a version segment in the URL.
- PostgreSQL is the primary system of record.

## Initial stack

- Node.js
- TypeScript
- Express
- PostgreSQL (`pg`)
- Zod for configuration validation
- Helmet and CORS for HTTP hardening
- Pino for structured logging

## Local development

1. Install Node.js 22+ and PostgreSQL 16+.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL` and the allowed frontend origins.
4. Run `npm install`.
5. Run `npm run migrate`.
6. Run `npm run dev`.

The first public endpoint is `GET /api/health`.

## Core data hierarchy

```text
Pioneer Legacy Works platform
        |
        +-- LegalEntity
              |
              +-- BusinessUnit
```

Users receive scoped role assignments to the platform, legal entity, or business unit. Later operational modules such as customers, scheduling, invoicing, forms, and bookkeeping will resolve and validate this context before accessing data.

## Development sequence

1. Platform configuration, database, migrations, health checks.
2. Legal entities, business units, users, roles, permissions, and audit logging.
3. Authentication and organization-context middleware.
4. Customers, contacts, addresses, files, and forms.
5. Scheduling, work orders, estimates, invoices, and payments.
6. Bookkeeping and reporting.

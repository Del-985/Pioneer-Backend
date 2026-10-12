# Pioneer Backend

Shared backend platform for Pioneer Legacy Works and its business units, websites, bookkeeping tools, admin systems, and future applications.

## Production API

Canonical production origin: `https://api.pioneerlegacyworks.com`

All Pioneer-owned frontends and applications should use that hostname. The Render `onrender.com` hostname is deployment infrastructure and is not part of the public application contract.

## Architectural rules

- One backend API serves every Pioneer-owned frontend and application.
- `LegalEntity` represents an actual legal/tax entity.
- `BusinessUnit` represents an operating division or brand and always belongs to a `LegalEntity`.
- Authorization and business/entity isolation are enforced by the backend, never only by frontend filters.
- Users are platform identities. Access to business data is granted through scoped role assignments.
- `All Businesses` is a reporting concern; it does not bypass entity isolation for mutations.
- Public application routes live under the stable `/api` namespace without a version segment in the URL.
- PostgreSQL is the primary system of record.

## Stack

- Node.js
- TypeScript
- Express
- PostgreSQL (`pg`)
- Zod for configuration validation
- Helmet and CORS for HTTP hardening
- Pino for structured logging
- S3-compatible object storage for attachment bytes when configured

## API documentation

- `docs/BACKEND_API.md` — shared backend contract and core modules.
- `docs/BOOKKEEPING_API.md` — Bookkeeping foundations, Chart of Accounts, periods, and journals.
- `docs/BOOKKEEPING_TRANSACTIONS.md` — unified transaction lifecycle.
- `docs/BOOKKEEPING_OPERATIONS.md` — dashboard, attachments, mileage, reconciliation, reports, intercompany, recurring accounting, audit, and idempotency.

## Local development

1. Install Node.js 22+ and PostgreSQL 16+.
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL` and the allowed frontend origins.
4. Run `npm install`.
5. Run `npm run migrate`.
6. Run `npm run dev`.

Local health endpoint: `GET /api/health`.
Production health endpoint: `GET https://api.pioneerlegacyworks.com/api/health`.
Production readiness endpoint: `GET https://api.pioneerlegacyworks.com/api/health/ready`.

## Core data hierarchy

```text
Pioneer Legacy Works platform
        |
        +-- LegalEntity
              |
              +-- BusinessUnit
```

Users receive scoped role assignments to the platform, legal entity, or business unit. Operational modules such as customers, scheduling, invoicing, forms, and bookkeeping resolve and validate this context before accessing data.

## Development sequence

1. Platform configuration, database, migrations, health checks.
2. Legal entities, business units, users, roles, permissions, and audit logging.
3. Authentication and organization-context middleware.
4. Customers, contacts, addresses, files, and forms.
5. Scheduling, work orders, estimates, invoices, and payments.
6. Bookkeeping and reporting.

### Quarterly tax preparation

`/payroll/filings` prepares original 2026 Q3/Q4 Form 941 for verified monthly depositors, consolidating recorded payments across the legal employer. Migration 061 restricts access to entity/platform administrators and stores immutable packets and reviews. Closed-quarter review and a fresh source digest are required for PDF export. Payments, reversals, missing payment records, legacy provider payroll, deposits, and unsupported deposit schedules are reconciled or blocked. No payment or agency submission occurs.

The unsigned interactive PDF uses the official March 2026 IRS Form 941 (`assets/tax/2026/f941.pdf`, retrieved from https://www.irs.gov/pub/irs-pdf/f941.pdf). Taxable wage bases come from verified prior wages, not reverse-calculated withholding; line 7 adjusts employee FICA rounding only. Deposit selections and any prior credit require agency reconciliation. Print/sign both return pages or use an authorized filing channel after review. Keep the assets directory in deployments.

CSV worksheets provide monthly and payday Ohio, residential school-district, and Toledo withholding totals. These are not agency returns; verify each assigned filing/payment frequency. Form 940, W-2/W-3, Ohio annual reconciliations, unemployment wage-detail returns, amended returns and Schedule B are not generated. See https://www.irs.gov/instructions/i941, https://tax.ohio.gov/business/employer-withholding/employer-withholding and https://toledo.oh.gov/pay-taxes. Preparing a packet does not resolve prior limitations of the gross wage engine; independently verified complete payroll is required.

# Pioneer Backend API

Pioneer Backend is the shared modular-monolith API for Pioneer Legacy Works. Routes live below `/api`; URL-path API versioning is intentionally not used.

## Core invariants

- `LegalEntity` is the legal/tax boundary.
- `BusinessUnit` is the operating division/brand boundary and belongs to exactly one `LegalEntity`.
- Operational records are Business Unit scoped.
- Ledger accounts are Legal Entity scoped.
- Journal entries identify both Legal Entity and Business Unit; PostgreSQL verifies the relationship.
- Authorization is enforced by the backend for every protected request.
- A client-supplied Business Unit or Legal Entity identifier is context, not proof of access.
- `All Businesses` is read-only consolidated reporting, not a mutation scope.
- Money is represented as integer cents.

## Authentication

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:sessionId`
- `POST /api/auth/sessions/revoke-others`
- `POST /api/auth/password/change`
- `POST /api/auth/password/reset/request`
- `POST /api/auth/password/reset`

Sessions are opaque, revocable, server-side records. Password reset tokens are stored only as hashes. Login and reset limits are PostgreSQL-backed so limits remain consistent across backend instances.

## Public site API

- `GET /api/public/sites/:siteKey`
- `GET /api/public/sites/:siteKey/pages/:slug`
- `GET /api/public/sites/:siteKey/business-units`
- `POST /api/public/sites/:siteKey/contact`

Public Business Unit directories respect the site's organizational scope. Contact submissions are stored centrally and, when a contact recipient is configured, enqueue an email notification without blocking the request on SMTP delivery.

## Shared application context

- `GET /api/business-units`

Returns Business Units the authenticated user may access. Applications should use this endpoint to establish active Business Unit context.

## Platform administration

- `/api/admin/overview`
- `/api/admin/access`
- `/api/admin/audit`
- `/api/admin/legal-entities`
- `/api/admin/business-units`
- `/api/admin/users`
- `/api/admin/sites`
- `/api/admin/reporting/consolidated`
- `/api/admin/intercompany`
- `/api/admin/notifications`
- `/api/admin/integrations`

### User security administration

- `GET /api/admin/users/:userId/security/sessions`
- `DELETE /api/admin/users/:userId/security/sessions/:sessionId`
- `POST /api/admin/users/:userId/security/sessions/revoke-all`
- `POST /api/admin/users/:userId/security/password-reset`

These endpoints are scope-aware. Administrators can issue a reset workflow; they cannot retrieve an existing password.

## Business Unit administration

The following modules are nested below `/api/admin/business-units/:businessUnitId`:

- `contacts`
- `customers`
- `files`
- `forms`
- `schedule`
- `estimates`
- `work-orders`
- `invoices`
- `payments`
- `employees`
- `vehicles`
- `mileage`
- `bookkeeping`
- `reports`
- `features`

### Customers and addresses

Customer CRUD uses the existing customer endpoints. Addresses are nested at:

- `GET /customers/:customerId/addresses`
- `POST /customers/:customerId/addresses`
- `PATCH /customers/:customerId/addresses/:addressId`

A customer may have a primary address by address type. Cross-Business-Unit attachment is rejected.

### Files and forms

Files store metadata only: ownership, object-storage key, content type, size, SHA-256 checksum, category, and metadata. Binary file bytes belong in object storage.

Forms can reference a file and/or structured JSON schema and support versioned library entries.

### Scheduling

- list/create schedule entries
- update status, time, assignment, customer, and metadata
- customer relationships are Business Unit validated

### Estimates

Estimates contain line items. The backend calculates line totals, subtotal, tax, and total from submitted quantities and unit prices.

### Work orders

Work orders may link to a customer, estimate, schedule entry, service address, and employee. Every relationship must resolve inside the active Business Unit.

### Invoices and payments

Invoices contain line items and backend-calculated totals. Completed payments are summed from payment records to derive invoice paid/partial state; the API does not blindly increment a paid counter.

A completed payment creates a pending `accounting_event`. Accounting can then post that event into the journal using selected debit/credit accounts.

## Employees, fleet, and mileage

Employees can optionally link to a global Pioneer user identity while remaining Business Unit records.

Vehicles are Business Unit scoped. Mileage logs record starting/ending odometer readings and calculate miles in PostgreSQL. New logs cannot roll the odometer backward; accepted logs advance the vehicle's current odometer.

## Bookkeeping

Bookkeeping routes are under `/api/admin/business-units/:businessUnitId/bookkeeping`.

### Chart of accounts

- `GET /accounts`
- `POST /accounts`
- `PATCH /accounts/:accountId`

Accounts belong to the Legal Entity. Creating or modifying the chart requires Legal Entity scope even when accessed through a Business Unit route.

### Journals

- `GET /journals`
- `POST /journals`
- `GET /journals/:journalId`
- `PATCH /journals/:journalId`
- `POST /journals/:journalId/post`
- `POST /journals/:journalId/reverse`

Draft journal entries may be prepared with `bookkeeping.write`. Posting/reversing requires `bookkeeping.post`. PostgreSQL refuses posting unless there are at least two lines, debits equal credits, and the total is positive. Journal line accounts must belong to the same Legal Entity as the journal.

### Accounting events

- `GET /events`
- `POST /events/:eventId/post`

Operational modules can emit accounting events without deciding the chart-of-accounts mapping. Posting an event supplies the debit/credit accounts and creates a journal entry.

### Expenses and revenue

- `/bookkeeping/expenses`
- `/bookkeeping/revenue`

Records begin as drafts. Posting requires account mapping and creates/links a balanced journal entry.

## Reporting

Business Unit reporting:

- `GET /api/admin/business-units/:businessUnitId/reports/summary`
- `GET /api/admin/business-units/:businessUnitId/reports/trial-balance`

Consolidated read-only reporting:

- `GET /api/admin/reporting/consolidated`

Consolidated reporting only aggregates Business Units visible to the authenticated user and may be filtered to one Legal Entity.

## Intercompany

- `GET /api/admin/intercompany`
- `POST /api/admin/intercompany`
- `PATCH /api/admin/intercompany/:intercompanyId`
- `POST /api/admin/intercompany/:intercompanyId/post`

An intercompany record must cross Legal Entity boundaries. Posting requires authorization on both sides and atomically creates two balanced journal entries in one database transaction.

## Notifications

- `GET /api/admin/notifications`
- `POST /api/admin/notifications/:notificationId/action`

The durable outbox supports email/webhook channel records. Email delivery is processed separately from request handling:

```text
npm run process-notifications
```

SMTP delivery retries failures with backoff and uses row locking so multiple workers can run safely. Password reset tokens are removed from outbox payloads after successful delivery.

Required SMTP configuration is optional until a worker is run: `SMTP_HOST`, `SMTP_FROM`, optional authentication, and `PASSWORD_RESET_URL` for reset emails.

## Integrations

- `GET /api/admin/integrations`
- `POST /api/admin/integrations`
- `PATCH /api/admin/integrations/:integrationId`

Integrations may be platform, Legal Entity, or Business Unit scoped. API responses never expose the stored `secret_reference`; they only indicate whether one exists. Actual secrets should remain in the deployment secret store and be resolved by provider adapters.

## Maintenance jobs

```text
npm run migrate
npm run cleanup-sessions
npm run process-notifications
```

`cleanup-sessions` removes old expired/revoked sessions, expired/consumed password-reset tokens, and stale rate-limit counters.

## CI

CI provisions PostgreSQL 16 and runs:

1. migrations
2. TypeScript typecheck
3. automated tests
4. production build

Integration tests cover scoped authorization and accounting database invariants in addition to unit tests for password hashing and shared HTTP/database utilities.

# Pioneer Backend API

Pioneer Backend is the shared modular-monolith API for Pioneer Legacy Works. Routes live below `/api`; URL-path API versioning is intentionally not used.

## Core invariants

- `LegalEntity` is the legal/tax boundary.
- `BusinessUnit` is the operating division/brand boundary and belongs to exactly one `LegalEntity`.
- Operational records are Business Unit scoped.
- Ledger accounts are Legal Entity scoped.
- Journal entries identify both Legal Entity and Business Unit; PostgreSQL verifies the relationship.
- Authorization is enforced by the backend for every protected request.
- Client-supplied Business Unit and Legal Entity identifiers are context, never proof of access.
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

Sessions are opaque, revocable, server-side records. Password reset tokens are stored only as hashes. Login and reset rate limits are PostgreSQL-backed.

## Public site API

- `GET /api/public/sites/:siteKey`
- `GET /api/public/sites/:siteKey/pages/:slug`
- `GET /api/public/sites/:siteKey/business-units`
- `POST /api/public/sites/:siteKey/contact`

Public Business Unit directories respect site scope. Contact submissions are stored centrally and can enqueue provider-independent notification work.

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

Admin Business Unit routes also expose operational modules such as customers, files, forms, scheduling, estimates, work orders, invoices, payments, employees, fleet, mileage, and bookkeeping compatibility aliases.

## Bookkeeping

The canonical Bookkeeping application API is `/api/bookkeeping`. The older `/api/admin/business-units/:businessUnitId/bookkeeping` routes remain available where needed for admin compatibility.

Bookkeeping permissions are:

- `bookkeeping.read`
- `bookkeeping.write`
- `bookkeeping.post`
- `bookkeeping.adjust`
- `bookkeeping.reconcile`
- `bookkeeping.close`
- `bookkeeping.audit.read`

Business Unit context is resolved to its Legal Entity on the server. Cross-entity account use is rejected.

### Chart of accounts

Canonical routes:

- `GET /api/bookkeeping/accounts?businessUnitId=...`
- `GET /api/bookkeeping/accounts/:accountId?businessUnitId=...`
- `POST /api/bookkeeping/accounts`
- `PATCH /api/bookkeeping/accounts/:accountId`
- `GET /api/bookkeeping/accounts/:accountId/register?businessUnitId=...`
- `PUT /api/bookkeeping/accounts/:accountId/opening-balance`

Accounts belong to the Legal Entity. Register activity and opening balances are Business Unit specific. Opening balances are balanced journal entries, not mutable account fields. System/control accounts can restrict manual use, and inactive accounts cannot be used for new accounting activity.

### Accounting periods

- `GET /api/bookkeeping/periods?businessUnitId=...`
- `POST /api/bookkeeping/periods`
- `POST /api/bookkeeping/periods/:periodId/close`
- `POST /api/bookkeeping/periods/:periodId/reopen`

Periods belong to a Legal Entity and can be `open`, `closed`, or `locked`. Overlap is rejected. Posting and draft financial edits in closed/locked periods are blocked by PostgreSQL. Reversals must use an open effective date.

### Unified transactions

- `GET /api/bookkeeping/transactions`
- `GET /api/bookkeeping/transactions/:transactionId`
- `POST /api/bookkeeping/transactions`
- `PATCH /api/bookkeeping/transactions/:transactionId`
- `POST /api/bookkeeping/transactions/:transactionId/post`
- `POST /api/bookkeeping/transactions/:transactionId/void`
- `POST /api/bookkeeping/transactions/:transactionId/reverse`

The transaction layer normalizes four workflows over the existing ledger engine:

- expense
- income
- transfer
- manual journal

Stable transaction IDs are type-prefixed (`expense:<uuid>`, `income:<uuid>`, `transfer:<uuid>`, `manual:<journal-uuid>`) so records from different source tables cannot be confused.

Search supports Business Unit, Legal Entity, account, type, status, date range, amount range, text search, and pagination. Without a Business Unit filter, reads are still limited to Business Units for which the user has `bookkeeping.read`.

Draft transactions can be edited or voided. Posted transactions cannot be destructively changed; they must be reversed. Reversal requires adjustment/posting authority and creates a new balanced journal using an open effective date.

Expense, income, and transfer posting are atomic. Journal creation, lines, posting, and source-record linkage/status updates occur inside one database transaction. Manual posting delegates to the journal engine.

See `docs/BOOKKEEPING_TRANSACTIONS.md` for the transaction payload and lifecycle contract.

### Journals

- `GET /api/bookkeeping/journals?businessUnitId=...`
- `POST /api/bookkeeping/journals`
- `GET /api/bookkeeping/journals/:journalId?businessUnitId=...`
- `PATCH /api/bookkeeping/journals/:journalId`
- `POST /api/bookkeeping/journals/:journalId/post`
- `POST /api/bookkeeping/journals/:journalId/reverse`

Journal statuses include `draft`, `posted`, `reversed`, and `void`. PostgreSQL refuses posting unless there are at least two lines, debits equal credits, and the total is positive. Journal line accounts must belong to the journal Legal Entity.

### Accounting events

- `GET /api/bookkeeping/events?businessUnitId=...`
- `POST /api/bookkeeping/events/:eventId/post`

Operational modules can emit accounting events without deciding chart-of-accounts mapping. Posting an event supplies debit/credit accounts and creates a journal entry.

### Expense and revenue compatibility endpoints

- `/api/bookkeeping/expenses`
- `/api/bookkeeping/revenue`

These remain available for focused workflows. Their posting actions use the same atomic posting services as the unified transaction API.

## Reporting

Business Unit reporting:

- `GET /api/admin/business-units/:businessUnitId/reports/summary`
- `GET /api/admin/business-units/:businessUnitId/reports/trial-balance`

Consolidated read-only reporting:

- `GET /api/admin/reporting/consolidated`

Consolidated reporting aggregates only Business Units visible to the authenticated user.

## Intercompany

- `GET /api/admin/intercompany`
- `POST /api/admin/intercompany`
- `PATCH /api/admin/intercompany/:intercompanyId`
- `POST /api/admin/intercompany/:intercompanyId/post`

Intercompany records cross Legal Entity boundaries. Posting requires authorization on both sides and atomically creates both journals.

## Notifications

- `GET /api/admin/notifications`
- `POST /api/admin/notifications/:notificationId/action`

The durable outbox supports email/webhook work. Email delivery is processed separately with:

```text
npm run process-notifications
```

## Integrations

- `GET /api/admin/integrations`
- `POST /api/admin/integrations`
- `PATCH /api/admin/integrations/:integrationId`

Integrations may be platform, Legal Entity, or Business Unit scoped. API responses do not expose stored secret references.

## Maintenance jobs

```text
npm run migrate
npm run cleanup-sessions
npm run process-notifications
```

## CI

CI provisions PostgreSQL 16 and runs:

1. migrations
2. TypeScript typecheck
3. automated tests
4. production build

Integration tests cover authorization, accounting database invariants, accounting periods/control accounts, and the unified transaction workflow.

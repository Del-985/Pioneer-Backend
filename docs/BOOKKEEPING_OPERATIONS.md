# Bookkeeping Operations API

Production origin: `https://api.pioneerlegacyworks.com`

All routes below are under `/api/bookkeeping` and require an authenticated Pioneer session. Business Unit and Legal Entity identifiers are context only; authorization and scope are resolved and enforced by the backend.

## Permissions

- `bookkeeping.read` — read books, dashboards, reports, attachments, mileage, reconciliation history, and recurring definitions.
- `bookkeeping.write` — create/edit draft transactions, attachments, mileage, and recurring definitions.
- `bookkeeping.post` — post financial transactions and intercompany journals.
- `bookkeeping.adjust` — opening balances, controlled adjustments, control-account configuration, and reversals.
- `bookkeeping.reconcile` — reconciliation and intercompany settlement workflows.
- `bookkeeping.close` — accounting-period close/lock/reopen.
- `bookkeeping.audit.read` — bookkeeping audit history.

`All Businesses` is always read-only. Mutation routes require a specific Business Unit.

## Dashboard

`GET /dashboard`

Optional scope: `businessUnitId` or `legalEntityId`. With neither, the response is a consolidated read-only view across accessible businesses.

The dashboard returns:

- cash balance and cash-account balances
- year-to-date revenue, expenses, and net income
- unreconciled cash-line count
- recent transactions

Consolidated dashboard/report calculations eliminate journals whose source is `intercompany_transaction`.

## Transactions

- `GET /transactions`
- `GET /transactions/:transactionId`
- `POST /transactions`
- `PATCH /transactions/:transactionId`
- `POST /transactions/:transactionId/post`
- `POST /transactions/:transactionId/void`
- `POST /transactions/:transactionId/reverse`

Supported transaction types are expense, income, transfer, and manual journal. Posted transactions are immutable and must be reversed rather than destructively edited.

Create, post, and reverse accept an optional `Idempotency-Key` header. Reusing the same key with the same request returns the stored result and `Idempotency-Replayed: true`; reusing it with a different request is rejected.

## Attachments and source documents

- `GET /attachments`
- `POST /attachments/upload-intent`
- `GET /attachments/:attachmentId`
- `POST /attachments/:attachmentId/complete`
- `GET /attachments/:attachmentId/download`
- `POST /attachments/:attachmentId/archive`

Attachment types include receipts, invoices, statements, source documents, and other supporting files. Targets can be journals, expenses, income records, transfers, reconciliations, or intercompany transactions.

PostgreSQL stores file metadata, target association, ownership, scope, and audit history. Binary bytes are stored in an S3-compatible object store. Upload/download endpoints issue short-lived signed URLs; the API does not store binary file contents on Render's filesystem.

Object storage configuration:

- `OBJECT_STORAGE_ENDPOINT` — optional for S3-compatible providers such as Cloudflare R2.
- `OBJECT_STORAGE_REGION`
- `OBJECT_STORAGE_BUCKET`
- `OBJECT_STORAGE_ACCESS_KEY_ID`
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`
- `OBJECT_STORAGE_FORCE_PATH_STYLE`
- `OBJECT_STORAGE_PRESIGN_SECONDS`

Attachment APIs that need signed URLs return `503 OBJECT_STORAGE_NOT_CONFIGURED` until storage is configured. Other bookkeeping APIs remain available.

## Mileage

- `GET /mileage`
- `POST /mileage`
- `PATCH /mileage/:mileageId`
- `POST /mileage/:mileageId/archive`
- `GET /mileage/summary`
- `GET /mileage/export.csv`

Mileage logs are Business Unit scoped and carry the resolved Legal Entity, creator, timestamps, status, vehicle, purpose, odometer readings, and calculated miles. Odometer rollback is rejected. Archive preserves historical records rather than deleting them.

## Reconciliation

- `GET /reconciliations`
- `POST /reconciliations`
- `GET /reconciliations/:reconciliationId`
- `GET /reconciliations/:reconciliationId/candidates`
- `POST /reconciliations/:reconciliationId/items`
- `DELETE /reconciliations/:reconciliationId/items/:itemId`
- `POST /reconciliations/:reconciliationId/complete`
- `POST /reconciliations/:reconciliationId/reopen`
- `POST /reconciliations/:reconciliationId/void`
- `GET /reconciliations/:reconciliationId/history`

A candidate must be a posted journal line for the reconciled account, Business Unit, and Legal Entity, on or before the statement date. A journal line cannot be reconciled twice.

Completion calculates the account-normal balance from opening balance plus cleared movement. Completion is rejected when the resulting difference exceeds `toleranceCents`. Completion supports `Idempotency-Key`.

## Reports

- `GET /reports/trial-balance`
- `GET /reports/profit-loss`
- `GET /reports/balance-sheet`
- `GET /reports/cash-flow`
- `GET /reports/general-ledger`
- `GET /reports/account-register`
- `GET /reports/export`

Common query fields:

- `businessUnitId` or `legalEntityId`
- `from`, `to`, or `asOf` as applicable
- `compareFrom` and `compareTo` for comparative P&L
- `accountId` for register/general-ledger filtering
- `format=json|csv`

Financial statements are generated from posted/reversed journal activity, not convenience expense/revenue tables, so manual journals and adjustments are included. Balance Sheet includes current earnings in equity. Consolidated `All Businesses` reporting is read-only and eliminates posted intercompany journal activity.

Cash Flow classifies cash-account movement as operating, investing, or financing based on counterpart account types. This is an accounting classification derived from ledger structure and is not a substitute for entity-specific GAAP policy configuration where a more specialized classification is required.

## Intercompany

- `GET /intercompany`
- `POST /intercompany`
- `PATCH /intercompany/:intercompanyId`
- `GET /intercompany/config`
- `PUT /intercompany/config`
- `POST /intercompany/:intercompanyId/post`
- `POST /intercompany/:intercompanyId/reconcile`
- `GET /intercompany/eliminations`

Each Legal Entity configures active `intercompany_receivable` (due-from) and `intercompany_payable` (due-to) control accounts. Configured posting requires authorization on both sides and creates both journals in one database transaction with the same intercompany source ID. If either side fails, neither side remains posted.

Reconciliation changes a posted intercompany record to settled only after both journals remain posted. Consolidated reporting excludes `intercompany_transaction` journals; the elimination endpoint exposes the source transactions used for that consolidation treatment.

## Recurring bookkeeping

- `GET /recurring`
- `POST /recurring`
- `GET /recurring/:recurringId`
- `PATCH /recurring/:recurringId`
- `DELETE /recurring/:recurringId` — disables; does not erase history.
- `POST /recurring/:recurringId/generate`
- `POST /recurring/:recurringId/post-now`
- `POST /recurring/generate-due`

Definitions support weekly, monthly, quarterly, and yearly schedules; interval count; start/end dates; next-run date; enabled state; and typed transaction templates.

Generated occurrences are unique by `(recurringId, scheduledDate)`, preventing duplicate generation. Generated transaction IDs are stored with the run. Post-now and generation endpoints support optional `Idempotency-Key`.

## Audit

`GET /audit`

Filters:

- Business Unit or Legal Entity
- actor user
- action
- resource type and resource ID
- date/time range
- pagination
- `format=json|csv`

The endpoint requires `bookkeeping.audit.read` and returns only bookkeeping audit events visible to the authenticated scope. Financial mutations emit structured metadata describing the affected resource and important before/after or posting context where applicable.

## Accounting periods and Chart of Accounts

The pre-existing first-class Bookkeeping API remains canonical for accounts, opening balances, registers, periods, journals, events, expenses, and revenue. Closed/locked periods are enforced by PostgreSQL as well as services. System/control accounts cannot be casually used by manual journals when manual entry is disabled.

## Integrity and maintenance

Financial multi-step writes use PostgreSQL transactions. Scope triggers and foreign keys reject cross-entity/cross-Business-Unit associations even if a service-layer check is accidentally missed.

Idempotency responses expire after 24 hours. `npm run cleanup-sessions` also removes expired bookkeeping idempotency records.

Money remains integer cents (`bigint`) throughout the financial schema to avoid floating-point storage errors.

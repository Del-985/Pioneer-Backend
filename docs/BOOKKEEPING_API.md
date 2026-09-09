# Pioneer Bookkeeping API

The Bookkeeping application uses the shared Pioneer Backend under `/api/bookkeeping`. All routes require authentication. `BusinessUnit` context is supplied by the client but is always resolved and authorized by the backend; a client-supplied identifier is never treated as proof of access.

## Scope model

- Ledger accounts belong to a `LegalEntity`.
- Journal activity belongs to a `BusinessUnit` and therefore to its parent `LegalEntity`.
- Accounting periods belong to a `LegalEntity` and apply to every Business Unit inside that entity.
- Opening balances are Business Unit specific and are represented by balanced journal entries.
- Consolidated `All Businesses` views remain read-only; mutation routes require an explicit Business Unit context.

For GET routes, pass `businessUnitId` as a query parameter. For POST/PATCH/PUT routes, include `businessUnitId` in the JSON request body. Legacy admin routes under `/api/admin/business-units/:businessUnitId/bookkeeping` remain supported.

## Permissions

The bookkeeping permission set is:

- `bookkeeping.read`
- `bookkeeping.write`
- `bookkeeping.post`
- `bookkeeping.adjust`
- `bookkeeping.reconcile`
- `bookkeeping.close`
- `bookkeeping.audit.read`

`platform_admin` and `entity_admin` receive the full bookkeeping permission set. `business_admin` retains normal Business Unit bookkeeping access and receives reconciliation permission, but does not receive entity-level posting/adjustment/period-close authority by default.

The bookkeeping module uses shared authorization primitives through dedicated bookkeeping helpers. Business Unit context is resolved server-side to its Legal Entity before entity-owned resources are accessed.

## Chart of Accounts

Canonical routes:

- `GET /api/bookkeeping/accounts?businessUnitId=...`
- `GET /api/bookkeeping/accounts/:accountId?businessUnitId=...`
- `POST /api/bookkeeping/accounts`
- `PATCH /api/bookkeeping/accounts/:accountId`
- `GET /api/bookkeeping/accounts/:accountId/register?businessUnitId=...`
- `PUT /api/bookkeeping/accounts/:accountId/opening-balance`

Accounts are Legal Entity wide. A Business Unit scoped reader can view the shared chart while chart mutations require Legal Entity level bookkeeping permission.

Account fields include:

- code
- name
- description
- account type
- subtype
- parent account
- active/inactive status
- system-account flag
- control-account type
- manual-entry permission
- created/updated user audit fields
- deactivation timestamp

Account codes are unique inside a Legal Entity. Active control-account types are also unique inside a Legal Entity. Control accounts must be system accounts.

Supported control types currently include cash, accounts receivable, accounts payable, retained earnings, opening balance equity, undeposited funds, sales tax payable, and intercompany receivable/payable.

Accounts are never destructively deleted through the API. Deactivation is the supported retirement mechanism. Inactive accounts cannot be used for new journal activity, but reversal journals may still reference them so historical corrections remain possible.

### Account register

The register endpoint returns posted/reversed journal activity for the selected Business Unit, with debit, credit, source, memo, and running balance data. Date-range and pagination filters are supported.

### Opening balances

Opening balances are not stored as loose account balance fields. They are posted as balanced journal entries against an explicit offset account. One active opening-balance definition is maintained per Business Unit/account combination.

Updating an opening balance atomically reverses the previous opening journal and posts the replacement. Setting `amountCents` to zero clears the opening-balance definition while preserving the historical reversal journal.

Opening-balance changes require `bookkeeping.adjust`.

## Accounting periods

Canonical routes:

- `GET /api/bookkeeping/periods?businessUnitId=...`
- `POST /api/bookkeeping/periods`
- `POST /api/bookkeeping/periods/:periodId/close`
- `POST /api/bookkeeping/periods/:periodId/reopen`

Period status is one of:

- `open`
- `closed`
- `locked`

Periods may not overlap within the same Legal Entity. Creating, closing, locking, or reopening a period requires `bookkeeping.close`.

The close endpoint accepts `{ "businessUnitId": "...", "lock": false }`. Setting `lock` to true moves the period directly to `locked` rather than `closed`.

Period controls are enforced in PostgreSQL as well as at the service layer. Closed/locked periods reject journal posting and protected accounting mutations. Journal-line edits are restricted to draft entries and open periods. Reversal entries use their own effective date, which must be open.

If no accounting period has been defined for a date, that date is currently treated as open. This permits gradual adoption of formal periods without breaking existing books.

## Journals and operational bookkeeping aliases

The first-class namespace also exposes the existing bookkeeping services:

- `/api/bookkeeping/journals`
- `/api/bookkeeping/events`
- `/api/bookkeeping/expenses`
- `/api/bookkeeping/revenue`

User-created journal routes force a manual source context; clients cannot impersonate an internal system source by supplying `sourceType`/`sourceId`.

The underlying database continues to enforce balanced postings, minimum line counts, positive total value, Legal Entity account ownership, and Business Unit-to-Legal Entity consistency.

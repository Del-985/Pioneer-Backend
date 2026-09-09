# Bookkeeping Transactions API

The transaction layer is the high-level bookkeeping workflow over the existing ledger engine. It does not duplicate journal state. Expenses, income, transfers, and manual journal entries are normalized behind one API while journal entries remain the accounting source of truth after posting.

All routes require authentication and enforce bookkeeping permissions through the shared scope model.

## Transaction IDs

Transaction IDs are stable, opaque strings with a type prefix:

- `expense:<uuid>`
- `income:<uuid>`
- `transfer:<uuid>`
- `manual:<journal-uuid>`

The prefix prevents ambiguity between UUIDs originating in different bookkeeping tables.

## Routes

- `GET /api/bookkeeping/transactions`
- `GET /api/bookkeeping/transactions/:transactionId`
- `POST /api/bookkeeping/transactions`
- `PATCH /api/bookkeeping/transactions/:transactionId`
- `POST /api/bookkeeping/transactions/:transactionId/post`
- `POST /api/bookkeeping/transactions/:transactionId/void`
- `POST /api/bookkeeping/transactions/:transactionId/reverse`

## Search and filtering

`GET /api/bookkeeping/transactions` supports:

- `businessUnitId`
- `legalEntityId`
- `accountId`
- `type` (`expense`, `income`, `transfer`, `manual`)
- `status` (`draft`, `posted`, `void`, `reversed`)
- `from`
- `to`
- `minAmountCents`
- `maxAmountCents`
- `search`
- normal `limit` / `offset` pagination

The query is scope-aware. Without a Business Unit filter it returns only transactions from Business Units for which the authenticated user has `bookkeeping.read`. Supplying a Business Unit never bypasses authorization.

## Creation workflows

`POST /api/bookkeeping/transactions` accepts a discriminated payload using `type`.

### Expense

Creates the existing expense record. Optional expense/payment accounts and receipt file metadata are validated against the selected Business Unit and Legal Entity. Setting `post: true` requires `entryNumber` and uses the atomic expense posting path.

### Income

Creates the existing revenue record. Optional income/deposit accounts and customer relationships remain scoped to the selected Business Unit. Setting `post: true` requires `entryNumber` and uses the atomic revenue posting path.

### Transfer

Transfers are stored in `bookkeeping_transfers`. Both accounts must belong to the same Legal Entity as the selected Business Unit and must be different accounts. Posting creates one balanced journal atomically:

- debit destination account
- credit source account

The transfer and journal are linked using journal `source_type = 'transfer'` and `source_id = transfer.id`.

### Manual

Manual transactions are draft journal entries with no system source. They use the existing journal-line validation and control-account restrictions. If `post: true`, the journal must balance before PostgreSQL permits posting.

## Editing

Only draft transactions are editable. The update endpoint routes the change to the underlying expense, income, transfer, or manual-journal service.

Accounting-period locks are enforced in PostgreSQL. Draft expense, income, transfer, and manual-journal changes fail when their effective date belongs to a closed or locked period.

## Posting

Only draft transactions can be posted. Posting requires `bookkeeping.post`.

Expense, income, and transfer posting are atomic financial operations: journal creation, journal lines, posting, and source-record linkage/status changes occur inside one database transaction. Manual posting delegates to the journal engine.

## Void versus reversal

Voiding and reversing are intentionally different operations.

- `void` is allowed only for draft/unposted transactions and requires `bookkeeping.write`.
- posted transactions cannot be voided.
- `reverse` is allowed only for posted transactions and requires both `bookkeeping.adjust` and posting authority.
- reversal creates a new balanced reversal journal with a caller-supplied effective date and entry number.
- the original posted journal is preserved and marked reversed.
- the reversal date must be in an open accounting period.

This prevents destructive editing of posted financial history.

## Permissions

- reads/search/detail: `bookkeeping.read`
- create/edit/draft void: `bookkeeping.write`
- posting: `bookkeeping.post`
- reversal: `bookkeeping.adjust` plus `bookkeeping.post`

All mutation requests require an explicit `businessUnitId`. There is no `All Businesses` mutation mode.

## Database protections

Migration `013_bookkeeping_transactions.sql` adds:

- `bookkeeping_transfers`
- indexes for Business Unit, Legal Entity, account, status, and date lookups
- transfer scope/account validation
- transfer accounting-period enforcement
- draft journal `void` status
- insert-time period enforcement for expense and income records
- draft manual-journal void period enforcement

The database remains the final authority for entity relationships, account status, accounting-period locks, journal balance, and cross-entity protections.

import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { currentAccountingDate, generatedReversalEntryNumber } from './accounting-date.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import { enrichTransactionIncomeCustomer } from './income-customer.service.js';
import { listTransactionAttachments } from './transaction-attachments.service.js';
import { createTransactionSchema, postTransactionSchema, reverseTransactionSchema, transactionListQuerySchema, voidTransactionSchema } from './transaction.schemas.js';
import { createBookkeepingTransaction, getBookkeepingTransaction, listBookkeepingTransactions, postBookkeepingTransaction, reverseBookkeepingTransaction, updateBookkeepingTransaction, voidBookkeepingTransaction } from './transaction.service.js';

export const bookkeepingTransactionRouter = Router();
bookkeepingTransactionRouter.use(requireAuth);

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function reversalInputFromRequest(body: unknown, transaction: { businessUnitId: string; description: string }) {
  const raw = bodyRecord(body);
  return reverseTransactionSchema.parse({
    ...raw,
    businessUnitId: raw.businessUnitId ?? transaction.businessUnitId,
    entryNumber: raw.entryNumber ?? generatedReversalEntryNumber(),
    transactionDate: raw.transactionDate ?? currentAccountingDate(),
    description: raw.description ?? `Reversal of ${transaction.description}`.slice(0, 1000),
  });
}

async function presentTransaction(value: unknown) { return enrichTransactionIncomeCustomer(value); }

bookkeepingTransactionRouter.get('/', async (req, res) => {
  res.json(await listBookkeepingTransactions(req.auth!.userId, transactionListQuerySchema.parse(req.query)));
});

bookkeepingTransactionRouter.post('/', async (req, res) => {
  const input = createTransactionSchema.parse(req.body);
  if (input.type === 'manual') {
    await assertBusinessUnitPermission(req.auth!.userId, input.businessUnitId, 'bookkeeping.adjust');
  }
  const result = await runIdempotent({
    userId: req.auth!.userId,
    operation: 'transaction.create',
    key: normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload: input,
    successStatus: 201,
    execute: async () => presentTransaction(await createBookkeepingTransaction(req.auth!.userId, input)),
  });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingTransactionRouter.get('/:transactionId', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const transaction = await presentTransaction(await getBookkeepingTransaction(req.auth!.userId, transactionId));
  const attachments = await listTransactionAttachments(req.auth!.userId, transactionId);
  res.json({ data: { ...transaction, attachments } });
});

bookkeepingTransactionRouter.patch('/:transactionId', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const transaction = await getBookkeepingTransaction(req.auth!.userId, transactionId);
  if (transaction.type === 'manual') {
    await assertBusinessUnitPermission(req.auth!.userId, transaction.businessUnitId, 'bookkeeping.adjust');
  }
  res.json({ data: await presentTransaction(await updateBookkeepingTransaction(req.auth!.userId, transactionId, req.body)) });
});

bookkeepingTransactionRouter.post('/:transactionId/post', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const input = postTransactionSchema.parse(req.body);
  const transaction = await getBookkeepingTransaction(req.auth!.userId, transactionId);
  if (transaction.type === 'manual') {
    await assertBusinessUnitPermission(req.auth!.userId, transaction.businessUnitId, 'bookkeeping.adjust');
  }
  if (transaction.status === 'posted') { res.json({ data: await presentTransaction(transaction) }); return; }
  const result = await runIdempotent({ userId: req.auth!.userId, operation: `transaction.post:${transactionId}`, key: normalizeIdempotencyKey(req.get('Idempotency-Key')), payload: input, execute: async () => presentTransaction(await postBookkeepingTransaction(req.auth!.userId, transactionId, input)) });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

bookkeepingTransactionRouter.post('/:transactionId/void', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const input = voidTransactionSchema.parse(req.body);
  const transaction = await getBookkeepingTransaction(req.auth!.userId, transactionId);
  if (transaction.status === 'void' || transaction.status === 'reversed') { res.json({ data: await presentTransaction(transaction) }); return; }
  if (transaction.status === 'posted') {
    const reversalInput = reversalInputFromRequest({ ...bodyRecord(req.body), businessUnitId: input.businessUnitId }, transaction);
    const result = await runIdempotent({ userId: req.auth!.userId, operation: `transaction.reverse:${transactionId}`, key: normalizeIdempotencyKey(req.get('Idempotency-Key')), payload: reversalInput, successStatus: 201, execute: async () => presentTransaction(await reverseBookkeepingTransaction(req.auth!.userId, transactionId, reversalInput)) });
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    res.status(result.status).json({ data: result.value });
    return;
  }
  res.json({ data: await presentTransaction(await voidBookkeepingTransaction(req.auth!.userId, transactionId, input)) });
});

bookkeepingTransactionRouter.post('/:transactionId/reverse', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const transaction = await getBookkeepingTransaction(req.auth!.userId, transactionId);
  if (transaction.status === 'reversed') { res.json({ data: await presentTransaction({ transaction, reversalJournal: null }) }); return; }
  const input = reversalInputFromRequest(req.body, transaction);
  const result = await runIdempotent({ userId: req.auth!.userId, operation: `transaction.reverse:${transactionId}`, key: normalizeIdempotencyKey(req.get('Idempotency-Key')), payload: input, successStatus: 201, execute: async () => presentTransaction(await reverseBookkeepingTransaction(req.auth!.userId, transactionId, input)) });
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  res.status(result.status).json({ data: result.value });
});

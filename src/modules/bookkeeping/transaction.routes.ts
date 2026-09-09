import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { normalizeIdempotencyKey, runIdempotent } from './idempotency.service.js';
import {
  createTransactionSchema,
  postTransactionSchema,
  reverseTransactionSchema,
  transactionListQuerySchema,
  voidTransactionSchema,
} from './transaction.schemas.js';
import {
  createBookkeepingTransaction,
  getBookkeepingTransaction,
  listBookkeepingTransactions,
  postBookkeepingTransaction,
  reverseBookkeepingTransaction,
  updateBookkeepingTransaction,
  voidBookkeepingTransaction,
} from './transaction.service.js';

export const bookkeepingTransactionRouter = Router();
bookkeepingTransactionRouter.use(requireAuth);

bookkeepingTransactionRouter.get('/', async (req, res) => {
  res.json(await listBookkeepingTransactions(req.auth!.userId, transactionListQuerySchema.parse(req.query)));
});

bookkeepingTransactionRouter.post('/', async (req, res) => {
  const input=createTransactionSchema.parse(req.body);
  const result=await runIdempotent({
    userId:req.auth!.userId,
    operation:'transaction.create',
    key:normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload:input,
    successStatus:201,
    execute:()=>createBookkeepingTransaction(req.auth!.userId,input),
  });
  res.setHeader('Idempotency-Replayed',String(result.replayed));
  res.status(result.status).json({data:result.value});
});

bookkeepingTransactionRouter.get('/:transactionId', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  res.json({ data: await getBookkeepingTransaction(req.auth!.userId, transactionId) });
});

bookkeepingTransactionRouter.patch('/:transactionId', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  res.json({ data: await updateBookkeepingTransaction(req.auth!.userId, transactionId, req.body) });
});

bookkeepingTransactionRouter.post('/:transactionId/post', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const input=postTransactionSchema.parse(req.body);
  const result=await runIdempotent({
    userId:req.auth!.userId,
    operation:`transaction.post:${transactionId}`,
    key:normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload:input,
    execute:()=>postBookkeepingTransaction(req.auth!.userId,transactionId,input),
  });
  res.setHeader('Idempotency-Replayed',String(result.replayed));
  res.status(result.status).json({data:result.value});
});

bookkeepingTransactionRouter.post('/:transactionId/void', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  res.json({ data: await voidBookkeepingTransaction(req.auth!.userId, transactionId, voidTransactionSchema.parse(req.body)) });
});

bookkeepingTransactionRouter.post('/:transactionId/reverse', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const input=reverseTransactionSchema.parse(req.body);
  const result=await runIdempotent({
    userId:req.auth!.userId,
    operation:`transaction.reverse:${transactionId}`,
    key:normalizeIdempotencyKey(req.get('Idempotency-Key')),
    payload:input,
    successStatus:201,
    execute:()=>reverseBookkeepingTransaction(req.auth!.userId,transactionId,input),
  });
  res.setHeader('Idempotency-Replayed',String(result.replayed));
  res.status(result.status).json({data:result.value});
});

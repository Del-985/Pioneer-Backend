import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
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
  res.json(await listBookkeepingTransactions(
    req.auth!.userId,
    transactionListQuerySchema.parse(req.query)
  ));
});

bookkeepingTransactionRouter.post('/', async (req, res) => {
  const data = await createBookkeepingTransaction(
    req.auth!.userId,
    createTransactionSchema.parse(req.body)
  );
  res.status(201).json({ data });
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
  res.json({
    data: await postBookkeepingTransaction(
      req.auth!.userId,
      transactionId,
      postTransactionSchema.parse(req.body)
    ),
  });
});

bookkeepingTransactionRouter.post('/:transactionId/void', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  res.json({
    data: await voidBookkeepingTransaction(
      req.auth!.userId,
      transactionId,
      voidTransactionSchema.parse(req.body)
    ),
  });
});

bookkeepingTransactionRouter.post('/:transactionId/reverse', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  res.status(201).json({
    data: await reverseBookkeepingTransaction(
      req.auth!.userId,
      transactionId,
      reverseTransactionSchema.parse(req.body)
    ),
  });
});

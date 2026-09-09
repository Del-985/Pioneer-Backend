import express, { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { getJournal } from './admin-bookkeeping.service.js';
import {
  archiveBookkeepingAttachment,
  completeBookkeepingAttachment,
  createBookkeepingAttachmentUploadIntent,
  deleteBookkeepingAttachment,
  getBookkeepingAttachment,
  getBookkeepingAttachmentDownload,
  getStoredBookkeepingAttachmentContent,
  listBookkeepingAttachments,
  storeBookkeepingAttachmentContent,
} from './attachment.service.js';
import {
  attachmentBusinessUnitBodySchema,
  attachmentListQuerySchema,
  createAttachmentUploadIntentSchema,
} from './completion.schemas.js';
import { getBookkeepingTransaction, parseBookkeepingTransactionId } from './transaction.service.js';

export const bookkeepingAttachmentRouter = Router();
bookkeepingAttachmentRouter.use(requireAuth);

const businessUnitQuerySchema = z.object({ businessUnitId: z.string().uuid() });

function queryBusinessUnitId(query: Record<string, unknown>) {
  return businessUnitQuerySchema.parse(query).businessUnitId;
}

function transactionTargetType(type: ReturnType<typeof parseBookkeepingTransactionId>['type']) {
  return type === 'manual' ? 'journal' as const : type;
}

async function transactionAttachmentContext(userId: string, transactionId: string, requestedBusinessUnitId?: string) {
  const parsed = parseBookkeepingTransactionId(transactionId);
  const transaction = await getBookkeepingTransaction(userId, transactionId);
  if (requestedBusinessUnitId && transaction.businessUnitId !== requestedBusinessUnitId) {
    throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found in the selected books.');
  }
  return {
    businessUnitId: transaction.businessUnitId,
    targetType: transactionTargetType(parsed.type),
    targetId: parsed.sourceId,
  };
}

bookkeepingAttachmentRouter.get('/attachments', async (req, res) => {
  res.json(await listBookkeepingAttachments(req.auth!.userId, attachmentListQuerySchema.parse(req.query)));
});

bookkeepingAttachmentRouter.post('/attachments/upload-intent', async (req, res) => {
  const data = await createBookkeepingAttachmentUploadIntent(
    req.auth!.userId,
    createAttachmentUploadIntentSchema.parse(req.body)
  );
  res.status(201).json({ data });
});

bookkeepingAttachmentRouter.get('/attachments/:attachmentId', async (req, res) => {
  const businessUnitId = queryBusinessUnitId(req.query);
  res.json({
    data: await getBookkeepingAttachment(
      req.auth!.userId,
      businessUnitId,
      requireRouteParam(req, 'attachmentId')
    ),
  });
});

bookkeepingAttachmentRouter.post(
  '/attachments/:attachmentId/content',
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  async (req, res) => {
    const businessUnitId = queryBusinessUnitId(req.query);
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError(400, 'ATTACHMENT_FILE_REQUIRED', 'An attachment file is required.');
    }
    res.json({
      data: await storeBookkeepingAttachmentContent(
        req.auth!.userId,
        businessUnitId,
        requireRouteParam(req, 'attachmentId'),
        req.body
      ),
    });
  }
);

bookkeepingAttachmentRouter.get('/attachments/:attachmentId/content', async (req, res) => {
  const businessUnitId = queryBusinessUnitId(req.query);
  const stored = await getStoredBookkeepingAttachmentContent(
    req.auth!.userId,
    businessUnitId,
    requireRouteParam(req, 'attachmentId')
  );
  res.setHeader('Content-Type', stored.contentType);
  res.setHeader('Content-Length', String(stored.content.length));
  res.attachment(stored.fileName);
  res.send(stored.content);
});

bookkeepingAttachmentRouter.post('/attachments/:attachmentId/complete', async (req, res) => {
  const { businessUnitId } = attachmentBusinessUnitBodySchema.parse(req.body);
  res.json({
    data: await completeBookkeepingAttachment(
      req.auth!.userId,
      businessUnitId,
      requireRouteParam(req, 'attachmentId')
    ),
  });
});

bookkeepingAttachmentRouter.get('/attachments/:attachmentId/download', async (req, res) => {
  const businessUnitId = queryBusinessUnitId(req.query);
  res.json({
    data: await getBookkeepingAttachmentDownload(
      req.auth!.userId,
      businessUnitId,
      requireRouteParam(req, 'attachmentId')
    ),
  });
});

bookkeepingAttachmentRouter.post('/attachments/:attachmentId/archive', async (req, res) => {
  const { businessUnitId } = attachmentBusinessUnitBodySchema.parse(req.body);
  res.json({
    data: await archiveBookkeepingAttachment(
      req.auth!.userId,
      businessUnitId,
      requireRouteParam(req, 'attachmentId')
    ),
  });
});

bookkeepingAttachmentRouter.delete('/attachments/:attachmentId', async (req, res) => {
  const businessUnitId = queryBusinessUnitId(req.query);
  res.json({
    data: await deleteBookkeepingAttachment(
      req.auth!.userId,
      businessUnitId,
      requireRouteParam(req, 'attachmentId')
    ),
  });
});

bookkeepingAttachmentRouter.get('/transactions/:transactionId/attachments', async (req, res) => {
  const transactionId = requireRouteParam(req, 'transactionId');
  const requestedBusinessUnitId = typeof req.query.businessUnitId === 'string' ? req.query.businessUnitId : undefined;
  const context = await transactionAttachmentContext(req.auth!.userId, transactionId, requestedBusinessUnitId);
  const query = attachmentListQuerySchema.parse({
    ...req.query,
    businessUnitId: context.businessUnitId,
    targetType: context.targetType,
    targetId: context.targetId,
  });
  res.json(await listBookkeepingAttachments(req.auth!.userId, query));
});

async function createTransactionAttachmentIntent(req: express.Request, res: express.Response) {
  const transactionId = requireRouteParam(req, 'transactionId');
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const requestedBusinessUnitId = typeof body.businessUnitId === 'string' ? body.businessUnitId : undefined;
  const context = await transactionAttachmentContext(req.auth!.userId, transactionId, requestedBusinessUnitId);
  const input = createAttachmentUploadIntentSchema.parse({
    ...body,
    businessUnitId: context.businessUnitId,
    targetType: context.targetType,
    targetId: context.targetId,
  });
  res.status(201).json({ data: await createBookkeepingAttachmentUploadIntent(req.auth!.userId, input) });
}

bookkeepingAttachmentRouter.post('/transactions/:transactionId/attachments/upload-intent', createTransactionAttachmentIntent);
bookkeepingAttachmentRouter.post('/transactions/:transactionId/attachments', createTransactionAttachmentIntent);

async function journalAttachmentContext(userId: string, journalId: string, businessUnitId: string) {
  await getJournal(userId, businessUnitId, journalId);
  return { businessUnitId, targetType: 'journal' as const, targetId: journalId };
}

async function listJournalAttachments(req: express.Request, res: express.Response) {
  const businessUnitId = queryBusinessUnitId(req.query);
  const journalId = requireRouteParam(req, 'journalId');
  const context = await journalAttachmentContext(req.auth!.userId, journalId, businessUnitId);
  const query = attachmentListQuerySchema.parse({
    ...req.query,
    ...context,
  });
  res.json(await listBookkeepingAttachments(req.auth!.userId, query));
}

async function createJournalAttachmentIntent(req: express.Request, res: express.Response) {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const businessUnitId = z.string().uuid().parse(body.businessUnitId);
  const journalId = requireRouteParam(req, 'journalId');
  const context = await journalAttachmentContext(req.auth!.userId, journalId, businessUnitId);
  const input = createAttachmentUploadIntentSchema.parse({ ...body, ...context });
  res.status(201).json({ data: await createBookkeepingAttachmentUploadIntent(req.auth!.userId, input) });
}

bookkeepingAttachmentRouter.get('/journals/:journalId/attachments', listJournalAttachments);
bookkeepingAttachmentRouter.post('/journals/:journalId/attachments/upload-intent', createJournalAttachmentIntent);
bookkeepingAttachmentRouter.post('/journals/:journalId/attachments', createJournalAttachmentIntent);
bookkeepingAttachmentRouter.get('/journal-entries/:journalId/attachments', listJournalAttachments);
bookkeepingAttachmentRouter.post('/journal-entries/:journalId/attachments/upload-intent', createJournalAttachmentIntent);
bookkeepingAttachmentRouter.post('/journal-entries/:journalId/attachments', createJournalAttachmentIntent);

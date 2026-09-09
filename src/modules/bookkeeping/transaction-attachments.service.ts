import { attachmentListQuerySchema } from './completion.schemas.js';
import { listBookkeepingAttachments } from './attachment.service.js';
import { getBookkeepingTransaction, parseBookkeepingTransactionId } from './transaction.service.js';

export async function listTransactionAttachments(userId: string, transactionId: string) {
  const parsed = parseBookkeepingTransactionId(transactionId);
  const transaction = await getBookkeepingTransaction(userId, transactionId);
  const targetType = parsed.type === 'manual' ? 'journal' : parsed.type;
  const result = await listBookkeepingAttachments(
    userId,
    attachmentListQuerySchema.parse({
      businessUnitId: transaction.businessUnitId,
      targetType,
      targetId: parsed.sourceId,
      status: 'active',
      limit: 100,
      offset: 0,
    })
  );
  return result.data;
}

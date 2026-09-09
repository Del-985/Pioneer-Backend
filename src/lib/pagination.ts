import { z } from 'zod';

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginationMeta(input: PaginationQuery, returnedCount: number) {
  return {
    limit: input.limit,
    offset: input.offset,
    returned: returnedCount,
    hasMore: returnedCount === input.limit,
    nextOffset: returnedCount === input.limit ? input.offset + input.limit : null,
  };
}

import { z } from 'zod';
import { IdSchema, PrioritySchema } from '../core/schema.js';

export const MAX_WORK_LIST_LIMIT = 50;
export const MAX_RELATED_CANDIDATES = 20;

export const WorkStateSchema = z.enum([
  'UNCLAIMED',
  'CLAIMED',
  'IN_PROGRESS',
  'WAITING',
  'BLOCKED',
  'SUBMITTED',
  'REVIEW',
  'RESOLVED',
]);

export const WorkResolutionReasonSchema = z.enum([
  'COMPLETED',
  'SUPERSEDED',
  'OBSOLETE',
  'CANCELLED',
  'DUPLICATE',
]);

/**
 * Stable idempotency key for one work operation. Replaying the same operation
 * returns the original receipt instead of duplicating or reversing a transition.
 */
export const OperationIdSchema = IdSchema;

const RefSchema = z.string().min(1).max(512);
const RefsSchema = z.array(RefSchema).max(16).optional();

export const CommissionWorkSchema = z.object({
  id: IdSchema,
  operationId: OperationIdSchema,
  objective: z.string().min(1).max(1024),
  priority: PrioritySchema,
  scopeRefs: z.array(z.string().min(1).max(256)).max(16).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(512)).max(16).optional(),
  evidenceRefs: RefsSchema,
  dependsOn: z.array(IdSchema).max(8).optional(),
  executorId: IdSchema.nullable().optional(),
  threadId: IdSchema.nullable().optional(),
  sourceMessageId: IdSchema.nullable().optional(),
  supersedesWorkId: IdSchema.nullable().optional(),
  supersedesExpectedRevision: z.number().int().min(1).optional(),
  note: z.string().max(1024).optional(),
});

export const ClaimWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  note: z.string().max(1024).optional(),
});

export const TransitionWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  toState: z.enum(['CLAIMED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED', 'REVIEW']),
  note: z.string().max(1024).optional(),
  evidenceRefs: RefsSchema,
});

export const ResolveWorkSchema = z
  .object({
    workId: IdSchema,
    operationId: OperationIdSchema,
    expectedRevision: z.number().int().min(1),
    reason: WorkResolutionReasonSchema,
    note: z.string().max(1024).optional(),
    replacementWorkId: IdSchema.nullable().optional(),
    evidenceRefs: RefsSchema,
  })
  .refine((v) => v.reason !== 'SUPERSEDED' || !!v.replacementWorkId, {
    message: 'A SUPERSEDED resolution must name the replacement work',
    path: ['replacementWorkId'],
  });

export const SupersedeWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  replacementWorkId: IdSchema,
  note: z.string().max(1024).optional(),
});

export const StopRequestSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  reason: z.string().min(3).max(512),
  note: z.string().max(1024).optional(),
});

export const StopHandoffSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  note: z.string().min(3).max(1024),
  evidenceRefs: RefsSchema,
});

export const TransferWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  toExecutorId: IdSchema,
  note: z.string().min(3).max(1024),
});

export const ReopenWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  reason: z.string().min(3).max(512),
});

export const ArchiveWorkSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
});

export const ProposeReleaseSchema = z.object({
  workId: IdSchema,
  operationId: OperationIdSchema,
  expectedRevision: z.number().int().min(1),
  note: z.string().min(3).max(1024),
});

export const RelatedWorkQuerySchema = z.object({
  scopeRefs: z.array(z.string().min(1).max(256)).max(16).optional(),
  objective: z.string().max(1024).optional(),
  threadId: IdSchema.nullable().optional(),
  limit: z.number().int().min(1).max(MAX_RELATED_CANDIDATES).optional(),
  includeResolved: z.boolean().optional(),
});

export const ListWorkQuerySchema = z.object({
  state: WorkStateSchema.optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_WORK_LIST_LIMIT).optional(),
  cursor: z.string().max(256).optional(),
});

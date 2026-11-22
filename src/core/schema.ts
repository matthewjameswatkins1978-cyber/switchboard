import { z } from 'zod';

export const MAX_BODY_BYTES = 32 * 1024; // 32 KiB
export const MAX_BATCH_MESSAGES = 32;
export const MAX_AGGREGATE_BATCH_BYTES = 256 * 1024; // 256 KiB

export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_\-.:]+$/, 'ID must contain only alphanumeric, _, -, ., or : characters');

export const PrioritySchema = z.enum(['urgent', 'normal', 'low']).default('normal');

export const RecipientTypeSchema = z.enum(['endpoint', 'channel']);

export const EndpointStateSchema = z.enum(['available', 'busy', 'waiting', 'stale', 'offline']);

export const EndpointRoleSchema = z.enum(['agent', 'service', 'human', 'admin']);

export const OutgoingMessageInputSchema = z
  .object({
    id: IdSchema,
    recipientType: RecipientTypeSchema,
    recipientId: IdSchema,
    kind: z.string().min(1).max(128),
    subject: z.string().min(1).max(256),
    payload: z.unknown(),
    priority: PrioritySchema,
    threadId: IdSchema.nullable().optional(),
    replyToId: IdSchema.nullable().optional(),
    evidenceRefs: z.array(z.string().url().or(z.string().min(1).max(512))).max(16).optional(),
  })
  .refine(
    (val) => {
      const json = JSON.stringify(val.payload ?? null);
      return new TextEncoder().encode(json).length <= MAX_BODY_BYTES;
    },
    {
      message: `Payload exceeds maximum size of ${MAX_BODY_BYTES} bytes (32 KiB)`,
      path: ['payload'],
    }
  );

export const AckInputSchema = z.object({
  messageId: IdSchema,
  senderId: IdSchema,
  note: z.string().max(512).optional(),
});

export const StatusUpdateInputSchema = z.object({
  state: EndpointStateSchema,
  description: z.string().max(512).nullable().optional(),
  expectedRevision: z.number().int().min(1).optional(),
});

export const SyncRequestSchema = z
  .object({
    sinceCursor: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_BATCH_MESSAGES).default(MAX_BATCH_MESSAGES),
    includeAcknowledged: z.boolean().default(false),
    outgoingMessages: z.array(OutgoingMessageInputSchema).max(MAX_BATCH_MESSAGES).optional(),
    acknowledgements: z.array(AckInputSchema).max(MAX_BATCH_MESSAGES).optional(),
    statusUpdate: StatusUpdateInputSchema.optional(),
  })
  .refine(
    (val) => {
      const json = JSON.stringify(val);
      return new TextEncoder().encode(json).length <= MAX_AGGREGATE_BATCH_BYTES;
    },
    {
      message: `Sync request exceeds aggregate limit of ${MAX_AGGREGATE_BATCH_BYTES} bytes (256 KiB)`,
    }
  );

export const CreateEndpointSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(128),
  role: EndpointRoleSchema.default('agent'),
});

export const CreateChannelSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(128),
  members: z.array(IdSchema).optional(),
});

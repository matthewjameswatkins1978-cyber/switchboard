import { describe, it, expect } from 'vitest';
import {
  OutgoingMessageInputSchema,
  SyncRequestSchema,
  MAX_BODY_BYTES,
  MAX_BATCH_MESSAGES,
} from '../../src/core/schema.js';

describe('Validation Schemas and Envelopes', () => {
  it('accepts valid outgoing message input', () => {
    const valid = {
      id: 'msg-001',
      recipientType: 'endpoint',
      recipientId: 'agent-b',
      kind: 'task.request.v1',
      subject: 'Review PR',
      payload: { taskId: 123, action: 'verify' },
      priority: 'urgent',
    };
    const parsed = OutgoingMessageInputSchema.parse(valid);
    expect(parsed.id).toBe('msg-001');
    expect(parsed.priority).toBe('urgent');
  });

  it('rejects payload exceeding 32 KiB body limit', () => {
    const largePayload = { data: 'x'.repeat(MAX_BODY_BYTES + 100) };
    const invalid = {
      id: 'msg-huge',
      recipientType: 'endpoint',
      recipientId: 'agent-b',
      kind: 'data.transfer.v1',
      subject: 'Huge Data',
      payload: largePayload,
    };
    expect(() => OutgoingMessageInputSchema.parse(invalid)).toThrowError(
      /Payload exceeds maximum size/
    );
  });

  it('rejects sync requests with more than 32 outgoing messages', () => {
    const messages = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, i) => ({
      id: `msg-${i}`,
      recipientType: 'endpoint',
      recipientId: 'agent-b',
      kind: 'note.v1',
      subject: `Note ${i}`,
      payload: { i },
    }));

    expect(() =>
      SyncRequestSchema.parse({
        outgoingMessages: messages,
      })
    ).toThrowError();
  });
});

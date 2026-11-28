import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthPrincipal } from '../core/types.js';
import type { WorkService } from './work-service.js';

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

const operationId = z
  .string()
  .min(1)
  .max(128)
  .describe('Stable idempotency key for this operation; replaying it returns the original receipt');

const expectedRevision = z
  .number()
  .int()
  .min(1)
  .describe('Revision observed by the caller; a stale value is refused instead of overwriting');

/**
 * Work-lifecycle tools for SWB-SWEEP-001. They are additive: existing messaging
 * tools keep identical behaviour, and read-only work inspection stays read-only.
 */
export function registerWorkTools(server: McpServer, work: WorkService, principal: AuthPrincipal): void {
  server.tool(
    'commission_work',
    {
      id: z.string().describe('Stable work ID'),
      operation_id: operationId,
      objective: z.string().describe('What the work must achieve'),
      priority: z.enum(['urgent', 'normal', 'low']).optional(),
      scope_refs: z.array(z.string()).optional().describe('Components, files or scopes this work touches'),
      acceptance_criteria: z.array(z.string()).optional(),
      evidence_refs: z.array(z.string()).optional(),
      depends_on: z.array(z.string()).optional(),
      executor_id: z.string().optional().describe('Assign directly to this endpoint; omit for an unclaimed assignment'),
      thread_id: z.string().optional(),
      source_message_id: z.string().optional(),
      supersedes_work_id: z.string().optional().describe('Explicitly supersede this outstanding work'),
      supersedes_expected_revision: z.number().int().optional(),
      note: z.string().optional(),
    },
    async (params) => {
      const result = await work.commission(principal, {
        id: params.id,
        operationId: params.operation_id,
        objective: params.objective,
        priority: params.priority ?? 'normal',
        scopeRefs: params.scope_refs,
        acceptanceCriteria: params.acceptance_criteria,
        evidenceRefs: params.evidence_refs,
        dependsOn: params.depends_on,
        executorId: params.executor_id ?? null,
        threadId: params.thread_id ?? null,
        sourceMessageId: params.source_message_id ?? null,
        supersedesWorkId: params.supersedes_work_id ?? null,
        supersedesExpectedRevision: params.supersedes_expected_revision,
        note: params.note,
      });
      return json(result);
    }
  );

  server.tool(
    'claim_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      note: z.string().optional(),
    },
    async (params) =>
      json(await work.claim(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        note: params.note,
      }))
  );

  server.tool(
    'update_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      to_state: z.enum(['CLAIMED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED', 'REVIEW']),
      note: z.string().optional(),
      evidence_refs: z.array(z.string()).optional(),
    },
    async (params) =>
      json(await work.transition(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        toState: params.to_state,
        note: params.note,
        evidenceRefs: params.evidence_refs,
      }))
  );

  server.tool(
    'resolve_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      reason: z.enum(['COMPLETED', 'SUPERSEDED', 'OBSOLETE', 'CANCELLED', 'DUPLICATE']),
      replacement_work_id: z.string().optional().describe('Required when the reason is SUPERSEDED'),
      note: z.string().optional(),
      evidence_refs: z.array(z.string()).optional(),
    },
    async (params) =>
      json(await work.resolve(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        reason: params.reason,
        replacementWorkId: params.replacement_work_id ?? null,
        note: params.note,
        evidenceRefs: params.evidence_refs,
      }))
  );

  server.tool(
    'supersede_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      replacement_work_id: z.string(),
      note: z.string().optional(),
    },
    async (params) =>
      json(await work.supersede(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        replacementWorkId: params.replacement_work_id,
        note: params.note,
      }))
  );

  server.tool(
    'request_work_stop',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      reason: z.string().describe('Why the executor should stop; recorded verbatim'),
      note: z.string().optional(),
    },
    async (params) =>
      json(await work.requestStop(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        reason: params.reason,
        note: params.note,
      }))
  );

  server.tool(
    'record_work_stop_handoff',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      note: z.string().describe('Where partial work, branches and evidence were left'),
      evidence_refs: z.array(z.string()).optional(),
    },
    async (params) =>
      json(await work.recordStopHandoff(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        note: params.note,
        evidenceRefs: params.evidence_refs,
      }))
  );

  server.tool(
    'transfer_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      to_executor_id: z.string(),
      note: z.string(),
    },
    async (params) =>
      json(await work.transfer(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        toExecutorId: params.to_executor_id,
        note: params.note,
      }))
  );

  server.tool(
    'propose_work_release',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      note: z.string(),
    },
    async (params) =>
      json(await work.proposeRelease(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        note: params.note,
      }))
  );

  server.tool(
    'reopen_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      reason: z.string(),
    },
    async (params) =>
      json(await work.reopen(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        reason: params.reason,
      }))
  );

  server.tool(
    'archive_work',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
    },
    async (params) =>
      json(await work.archive(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
      }))
  );

  server.tool(
    'list_work',
    {
      state: z
        .enum(['UNCLAIMED', 'CLAIMED', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED', 'REVIEW', 'RESOLVED'])
        .optional(),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      cursor: z.string().optional(),
    },
    { readOnlyHint: true },
    async (params) =>
      json(await work.list(principal, {
        state: params.state,
        includeArchived: params.include_archived,
        limit: params.limit,
        cursor: params.cursor,
      }))
  );

  server.tool(
    'get_work',
    {
      work_id: z.string(),
      event_limit: z.number().int().min(1).max(200).optional(),
    },
    { readOnlyHint: true },
    async (params) => json(await work.get(principal, params.work_id, { eventLimit: params.event_limit }))
  );

  server.tool(
    'get_work_board',
    {},
    { readOnlyHint: true },
    async () => json(await work.board(principal))
  );

  server.tool(
    'related_work',
    {
      scope_refs: z.array(z.string()).optional(),
      objective: z.string().optional(),
      thread_id: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    { readOnlyHint: true },
    async (params) =>
      json(await work.relatedWork(principal, {
        scopeRefs: params.scope_refs,
        objective: params.objective,
        threadId: params.thread_id ?? null,
        limit: params.limit,
      }))
  );

  server.tool(
    'record_reconciliation',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      decision: z.enum(['retained', 'reprioritised', 'combined', 'superseded', 'withdrawn', 'cancelled', 'referred']),
      note: z.string().optional(),
    },
    async (params) =>
      json(await work.resolveReconciliation(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        decision: params.decision,
        note: params.note,
      }))
  );

  server.tool(
    'transfer_commissionership',
    {
      work_id: z.string(),
      operation_id: operationId,
      expected_revision: expectedRevision,
      to_commissioner_id: z.string(),
      note: z.string(),
    },
    async (params) =>
      json(await work.transferCommissionership(principal, {
        workId: params.work_id,
        operationId: params.operation_id,
        expectedRevision: params.expected_revision,
        toCommissionerId: params.to_commissioner_id,
        note: params.note,
      }))
  );
}

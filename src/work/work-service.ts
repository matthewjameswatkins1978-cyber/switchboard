import type { DatabaseSession } from '../db/database.js';
import type { AuthPrincipal, EndpointRole, Priority } from '../core/types.js';
import { SwitchboardError } from '../core/errors.js';
import { sha256 } from '../auth/auth-service.js';
import {
  ArchiveWorkSchema,
  ClaimWorkSchema,
  CommissionWorkSchema,
  ResolveReconciliationSchema,
  TransferCommissionershipSchema,
  ListWorkQuerySchema,
  ProposeReleaseSchema,
  RelatedWorkQuerySchema,
  ReopenWorkSchema,
  ResolveWorkSchema,
  StopHandoffSchema,
  StopRequestSchema,
  SupersedeWorkSchema,
  TransferWorkSchema,
  TransitionWorkSchema,
} from './schema.js';
import type {
  CommissionWorkResult,
  RelatedWorkResult,
  WorkBoard,
  WorkCandidate,
  WorkDetail,
  WorkEvent,
  WorkEventType,
  WorkItem,
  WorkListResult,
  WorkReceipt,
  WorkResolutionReason,
  WorkState,
} from './types.js';

/**
 * SWB-SWEEP-001 — optional work-lifecycle coordination layer.
 *
 * Invariants this module is responsible for:
 *  - Delivery state and work state are independent. Acknowledgement never
 *    resolves work, and work never disappears because a delivery aged out.
 *  - Every consequential change is authority-checked, reason-bearing, revision
 *    guarded and receipted. Replays return the original receipt.
 *  - Archival is logical. Nothing is deleted and history stays retrievable.
 *  - No inference, no polling loop and no model dependency: candidates are
 *    ranked by deterministic field overlap only.
 */

interface WorkRow {
  project_id: string;
  id: string;
  state: WorkState;
  resolution_reason: WorkResolutionReason | null;
  priority: Priority;
  objective: string;
  scope_refs: string | null;
  acceptance_criteria: string | null;
  evidence_refs: string | null;
  depends_on: string | null;
  commissioner_id: string;
  commissioner_role: EndpointRole;
  executor_id: string | null;
  claimed_at: number | null;
  submitted_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  thread_id: string | null;
  source_message_id: string | null;
  replaces_work_id: string | null;
  superseded_by_work_id: string | null;
  stop_requested_at: number | null;
  stop_requested_by: string | null;
  stop_reason: string | null;
  stop_handoff_at: number | null;
  exec_episode: number;
  stop_seq: number;
  stop_open: number;
  handoff_episode: number | null;
  handoff_stop_seq: number | null;
  handoff_by: string | null;
  exec_started_episode: number | null;
  reconciliation_deferred: number;
  archived_at: number | null;
  revision: number;
  last_event_seq: number;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  project_id: string;
  work_id: string;
  seq: number;
  event_type: WorkEventType;
  from_state: WorkState | null;
  to_state: WorkState;
  actor_id: string;
  actor_role: EndpointRole;
  reason: string | null;
  note: string | null;
  evidence_refs: string | null;
  operation_id: string;
  expected_revision: number | null;
  resulting_revision: number;
  resulting_resolution_reason: WorkResolutionReason | null;
  operation_hash: string | null;
  created_at: number;
}

const WORK_COLUMNS = `project_id, id, state, resolution_reason, priority, objective, scope_refs,
  acceptance_criteria, evidence_refs, depends_on, commissioner_id, commissioner_role, executor_id,
  claimed_at, submitted_at, resolved_at, resolved_by, thread_id, source_message_id,
  replaces_work_id, superseded_by_work_id, stop_requested_at, stop_requested_by, stop_reason,
  stop_handoff_at, exec_episode, stop_seq, stop_open, handoff_episode, handoff_stop_seq,
  handoff_by, exec_started_episode, reconciliation_deferred, archived_at, revision,
  last_event_seq, created_at, updated_at`;

const EVENT_COLUMNS = `project_id, work_id, seq, event_type, from_state, to_state, actor_id,
  actor_role, reason, note, evidence_refs, operation_id, expected_revision, resulting_revision,
  resulting_resolution_reason, operation_hash, created_at`;

const PRIORITY_RANK_SQL = `CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`;

const EXECUTION_TRANSITIONS: Record<WorkState, WorkState[]> = {
  UNCLAIMED: ['CLAIMED'],
  CLAIMED: ['IN_PROGRESS', 'WAITING', 'BLOCKED', 'SUBMITTED'],
  IN_PROGRESS: ['WAITING', 'BLOCKED', 'SUBMITTED', 'CLAIMED'],
  WAITING: ['IN_PROGRESS', 'BLOCKED', 'SUBMITTED'],
  BLOCKED: ['IN_PROGRESS', 'WAITING'],
  SUBMITTED: ['REVIEW', 'IN_PROGRESS'],
  REVIEW: ['IN_PROGRESS'],
  RESOLVED: [],
};


function parseRefs(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function serializeRefs(values: string[] | null | undefined): string | null {
  if (!values || values.length === 0) return null;
  return JSON.stringify(values);
}

function mapWork(row: WorkRow): WorkItem {
  return {
    projectId: row.project_id,
    id: row.id,
    state: row.state,
    resolutionReason: row.resolution_reason ?? null,
    priority: row.priority,
    objective: row.objective,
    scopeRefs: parseRefs(row.scope_refs),
    acceptanceCriteria: parseRefs(row.acceptance_criteria),
    evidenceRefs: parseRefs(row.evidence_refs),
    dependsOn: parseRefs(row.depends_on),
    commissionerId: row.commissioner_id,
    commissionerRole: row.commissioner_role,
    executorId: row.executor_id ?? null,
    claimedAt: row.claimed_at ?? null,
    submittedAt: row.submitted_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolvedBy: row.resolved_by ?? null,
    threadId: row.thread_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    replacesWorkId: row.replaces_work_id ?? null,
    supersededByWorkId: row.superseded_by_work_id ?? null,
    stopRequestedAt: row.stop_requested_at ?? null,
    stopRequestedBy: row.stop_requested_by ?? null,
    stopReason: row.stop_reason ?? null,
    stopHandoffAt: row.stop_handoff_at ?? null,
    execEpisode: Number(row.exec_episode ?? 0),
    stopSeq: Number(row.stop_seq ?? 0),
    stopOpen: Number(row.stop_open ?? 0) === 1,
    handoffEpisode: row.handoff_episode ?? null,
    handoffStopSeq: row.handoff_stop_seq ?? null,
    handoffBy: row.handoff_by ?? null,
    execStartedEpisode: row.exec_started_episode ?? null,
    reconciliationDeferred: Number(row.reconciliation_deferred) === 1,
    archivedAt: row.archived_at ?? null,
    revision: Number(row.revision),
    lastEventSeq: Number(row.last_event_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapEvent(row: EventRow): WorkEvent {
  return {
    projectId: row.project_id,
    workId: row.work_id,
    seq: Number(row.seq),
    eventType: row.event_type,
    fromState: row.from_state ?? null,
    toState: row.to_state,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    reason: row.reason ?? null,
    note: row.note ?? null,
    evidenceRefs: parseRefs(row.evidence_refs),
    operationId: row.operation_id,
    expectedRevision: row.expected_revision ?? null,
    resultingRevision: Number(row.resulting_revision),
    resultingResolutionReason: row.resulting_resolution_reason ?? null,
    operationHash: row.operation_hash ?? null,
    createdAt: Number(row.created_at),
  };
}

/**
 * Binds an operation id to its canonical content. Two callers may share an
 * operation id only when they submit byte-identical canonical content for the
 * same event type and target; anything else is a conflict, never a replay.
 * Keys are sorted so field order cannot fork the binding.
 */
async function hashOperation(input: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(sortKeys(input));
  return await sha256(canonical);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * C1 episode gate (Lucy-directed). A handoff satisfies the gate only when it
 * is bound to the CURRENT execution episode, the CURRENT stop request and
 * the CURRENT executor. History is preserved in work_events; only these
 * live markers decide.
 */
function handoffSatisfied(work: WorkItem): boolean {
  return (
    work.handoffEpisode !== null &&
    work.handoffEpisode === work.execEpisode &&
    work.handoffStopSeq !== null &&
    work.handoffStopSeq === work.stopSeq &&
    work.handoffBy !== null &&
    work.executorId !== null &&
    work.handoffBy === work.executorId
  );
}

/**
 * Active ownership with a potentially executing assignment: an executor is
 * (or was, in this episode) attached and the work is live. Truly unclaimed
 * work and verified no-start work (claimed but never entered IN_PROGRESS
 * in this episode, never stopped) are NOT gated: there is no partial
 * execution to abandon.
 */
function needsHandoffGate(work: WorkItem): boolean {
  if (work.executorId === null || work.state === 'UNCLAIMED' || work.state === 'RESOLVED') {
    return false;
  }
  // Verified no-start is narrow: never entered IN_PROGRESS in this episode,
  // never left the unclaimed/claimed states, and never stopped. Presence in
  // WAITING, BLOCKED, SUBMITTED or REVIEW implies execution activity even
  // without an IN_PROGRESS record, so it never counts as no-start.
  const neverStarted =
    (work.execStartedEpisode === null || work.execStartedEpisode !== work.execEpisode) &&
    work.state === 'CLAIMED' &&
    work.stopSeq === 0 &&
    !work.stopOpen;
  if (neverStarted) {
    return false;
  }
  return true;
}

function candidateFrom(work: WorkItem, matchReasons: string[] = []): WorkCandidate {
  return {
    workId: work.id,
    state: work.state,
    priority: work.priority,
    objective: work.objective.length > 200 ? `${work.objective.slice(0, 197)}...` : work.objective,
    revision: work.revision,
    updatedAt: work.updatedAt,
    matchReasons,
    resolutionReason: work.resolutionReason,
    supersededByWorkId: work.supersededByWorkId,
    evidenceRefs: work.evidenceRefs.slice(0, 4),
  };
}

function objectiveTokens(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4)
  );
}

export class WorkService {
  private db: DatabaseSession;

  constructor(db: DatabaseSession) {
    this.db = db;
  }

  get database(): DatabaseSession {
    return this.db;
  }

  // ---------------------------------------------------------------------
  // Authority
  // ---------------------------------------------------------------------

  private hasWrite(principal: AuthPrincipal): boolean {
    return principal.scopes.includes('write');
  }

  /**
   * Stewardship is project-scoped by construction (a principal is bound to one
   * project by its credential) and requires the explicit admin role. Being
   * described as a steward elsewhere grants nothing here.
   */
  private isSteward(principal: AuthPrincipal): boolean {
    return principal.role === 'admin' && this.hasWrite(principal);
  }

  private canRead(principal: AuthPrincipal): boolean {
    return principal.scopes.includes('read') || principal.scopes.includes('write');
  }

  private requireWrite(principal: AuthPrincipal): void {
    if (!this.hasWrite(principal)) {
      throw new SwitchboardError('FORBIDDEN', 'Work mutations require the write scope');
    }
  }

  private requireRead(principal: AuthPrincipal): void {
    if (!this.canRead(principal)) {
      throw new SwitchboardError('FORBIDDEN', 'Work inspection requires the read scope');
    }
  }

  private requireCommissionerOrSteward(principal: AuthPrincipal, work: WorkItem, action: string): void {
    if (this.isSteward(principal)) return;
    if (work.commissionerId === principal.endpointId) return;
    throw new SwitchboardError(
      'FORBIDDEN',
      `Only the commissioner of '${work.id}' or an authorised project steward may ${action}`
    );
  }

  private requireExecutorOrSteward(principal: AuthPrincipal, work: WorkItem, action: string): void {
    if (this.isSteward(principal)) return;
    if (work.executorId && work.executorId === principal.endpointId) return;
    throw new SwitchboardError(
      'FORBIDDEN',
      `Only the assigned executor of '${work.id}' or an authorised project steward may ${action}`
    );
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  private async loadWork(projectId: string, workId: string): Promise<WorkItem> {
    const row = await this.db.queryFirst<WorkRow>(
      `SELECT ${WORK_COLUMNS} FROM work_items WHERE project_id = ? AND id = ?`,
      [projectId, workId]
    );
    if (!row) {
      throw new SwitchboardError('NOT_FOUND', `Work '${workId}' was not found in this project`);
    }
    return mapWork(row);
  }

  private async findEvent(projectId: string, operationId: string): Promise<WorkEvent | null> {
    const row = await this.db.queryFirst<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM work_events WHERE project_id = ? AND operation_id = ?`,
      [projectId, operationId]
    );
    return row ? mapEvent(row) : null;
  }

  /**
   * C2 replay guard. A stored receipt is returned for an operation id only
   * when the replaying principal passes the same authority check the fresh
   * operation requires, and only when the canonical content matches what the
   * id was first committed with. Different content under a known id is a
   * conflict; an unauthorised caller gets no receipt at all.
   */
  private async checkReplay(
    principal: AuthPrincipal,
    event: WorkEvent,
    operationHash: string,
    authorize: (work: WorkItem) => void
  ): Promise<WorkReceipt> {
    const work = await this.loadWork(principal.projectId, event.workId);
    // The original actor's identical retry is always accepted; anyone else
    // must satisfy the fresh operation's authority check as it stands now.
    if (event.actorId !== principal.endpointId) authorize(work);
    if (event.operationHash !== operationHash) {
      throw new SwitchboardError(
        'CONFLICT',
        `Operation '${event.operationId}' was already committed with different content; choose a new operation id`,
        { details: { operationId: event.operationId, workId: event.workId } }
      );
    }
    return this.receiptFrom(event, work, true);
  }

  private receiptFrom(event: WorkEvent, _work: WorkItem | null, isReplay: boolean): WorkReceipt {
    return {
      operationId: event.operationId,
      workId: event.workId,
      eventSeq: event.seq,
      eventType: event.eventType,
      state: event.toState,
      resolutionReason: event.resultingResolutionReason,
      revision: event.resultingRevision,
      actorId: event.actorId,
      at: event.createdAt,
      isReplay,
    };
  }

  async get(principal: AuthPrincipal, workId: string, options: { includeEvents?: boolean; eventLimit?: number } = {}): Promise<WorkDetail> {
    this.requireRead(principal);
    const work = await this.loadWork(principal.projectId, workId);
    if (options.includeEvents === false) {
      return { work, events: [], historyTruncated: false };
    }
    const eventLimit = Math.min(Math.max(options.eventLimit ?? 50, 1), 200);
    const rows = await this.db.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM work_events
       WHERE project_id = ? AND work_id = ?
       ORDER BY seq DESC LIMIT ?`,
      [principal.projectId, work.id, eventLimit + 1]
    );
    const events = rows.slice(0, eventLimit).map(mapEvent).reverse();
    return { work, events, historyTruncated: rows.length > eventLimit };
  }

  async list(principal: AuthPrincipal, query: unknown = {}): Promise<WorkListResult> {
    this.requireRead(principal);
    const parsed = ListWorkQuerySchema.parse(query);
    const limit = parsed.limit ?? 20;
    const where: string[] = ['project_id = ?'];
    const params: unknown[] = [principal.projectId];
    if (!parsed.includeArchived) where.push('archived_at IS NULL');
    if (parsed.state) {
      where.push('state = ?');
      params.push(parsed.state);
    }
    if (parsed.cursor) {
      const [createdAtRaw, ...idParts] = parsed.cursor.split(':');
      const createdAt = Number(createdAtRaw);
      const cursorId = idParts.join(':');
      if (!Number.isFinite(createdAt) || !cursorId) {
        throw new SwitchboardError('INVALID_INPUT', 'Malformed work list cursor');
      }
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(createdAt, createdAt, cursorId);
    }
    const rows = await this.db.query<WorkRow>(
      `SELECT ${WORK_COLUMNS} FROM work_items
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, limit + 1]
    );
    const page = rows.slice(0, limit).map((row) => mapWork(row));
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    return {
      items: page.map((work) => candidateFrom(work, ['listed'])),
      nextCursor: hasMore && last ? `${last.createdAt}:${last.id}` : null,
      hasMore,
    };
  }

  /**
   * Bounded deterministic candidate retrieval. Nothing here decides that two
   * assignments are equivalent; it only narrows what a commissioner should look at.
   */
  async relatedWork(principal: AuthPrincipal, query: unknown = {}): Promise<RelatedWorkResult> {
    this.requireRead(principal);
    const parsed = RelatedWorkQuerySchema.parse(query);
    const limit = parsed.limit ?? 5;

    const where: string[] = ['project_id = ?'];
    const params: unknown[] = [principal.projectId];
    if (!parsed.includeResolved) {
      where.push(`state <> 'RESOLVED'`);
    }
    if (!this.isSteward(principal)) {
      where.push('(commissioner_id = ? OR executor_id = ?)');
      params.push(principal.endpointId, principal.endpointId);
    }

    const rows = await this.db.query<WorkRow>(
      `SELECT ${WORK_COLUMNS} FROM work_items
       WHERE ${where.join(' AND ')}
       ORDER BY ${PRIORITY_RANK_SQL} ASC, updated_at DESC, id ASC
       LIMIT 100`,
      params
    );

    const scopeTargets = new Set(parsed.scopeRefs ?? []);
    const tokens = objectiveTokens(parsed.objective);
    const scored = rows.map((row) => {
      const work = mapWork(row);
      const reasons: string[] = [];
      let score = 0;
      if (parsed.threadId && work.threadId && parsed.threadId === work.threadId) {
        score += 3;
        reasons.push('same-thread');
      }
      const shared = work.scopeRefs.filter((ref) => scopeTargets.has(ref));
      if (shared.length > 0) {
        score += Math.min(shared.length, 2) * 2;
        reasons.push(`scope-overlap:${shared.slice(0, 2).join(',')}`);
      }
      if (tokens.size > 0) {
        const overlap = [...objectiveTokens(work.objective)].filter((t) => tokens.has(t));
        if (overlap.length > 0) {
          score += 1;
          reasons.push(`shared-terms:${overlap.slice(0, 3).join(',')}`);
        }
      }
      if (work.state === 'UNCLAIMED') reasons.push('unclaimed');
      if (work.stopRequestedAt) reasons.push('stop-requested');
      if (work.state === 'RESOLVED') reasons.push(`resolved:${work.resolutionReason}`);
      return { work, score, reasons };
    });

    const ranked = scored
      .sort((a, b) => b.score - a.score || b.work.updatedAt - a.work.updatedAt || a.work.id.localeCompare(b.work.id))
      .slice(0, limit)
      .map((entry) => candidateFrom(entry.work, entry.reasons.length > 0 ? entry.reasons : ['outstanding']));

    const totalRow = await this.db.queryFirst<{ c: number }>(
      `SELECT COUNT(*) AS c FROM work_items WHERE ${where.join(' AND ')}`,
      params
    );
    const totalOutstanding = Number(totalRow?.c ?? rows.length);
    return { candidates: ranked, outstandingCount: totalOutstanding, truncated: totalOutstanding > ranked.length };
  }

  async board(principal: AuthPrincipal): Promise<WorkBoard> {
    this.requireRead(principal);
    const projectId = principal.projectId;
    const perSection = 5;

    const countRows = await this.db.query<{ state: WorkState; archived_at: number | null; c: number }>(
      `SELECT state, archived_at, COUNT(*) AS c FROM work_items
       WHERE project_id = ? GROUP BY state, archived_at`,
      [projectId]
    );
    const countMap = new Map<string, number>();
    for (const row of countRows) {
      const key = `${row.state}:${row.archived_at === null ? 'active' : 'archived'}`;
      countMap.set(key, Number(row.c));
    }
    const countOf = (states: WorkState[]) =>
      states.reduce((sum, state) => sum + (countMap.get(`${state}:active`) ?? 0), 0);

    const stopRow = await this.db.queryFirst<{ c: number }>(
      `SELECT COUNT(*) AS c FROM work_items
       WHERE project_id = ? AND archived_at IS NULL AND state <> 'RESOLVED' AND stop_requested_at IS NOT NULL`,
      [projectId]
    );
    const reconRow = await this.db.queryFirst<{ c: number }>(
      `SELECT COUNT(*) AS c FROM work_items
       WHERE project_id = ? AND archived_at IS NULL AND state <> 'RESOLVED' AND reconciliation_deferred = 1`,
      [projectId]
    );
    const unackedRow = await this.db.queryFirst<{ c: number }>(
      `SELECT COUNT(*) AS c FROM message_deliveries
       WHERE project_id = ? AND status IN ('STORED', 'RECEIVED')`,
      [projectId]
    );
    const deadRow = await this.db.queryFirst<{ c: number }>(
      `SELECT COUNT(*) AS c FROM message_deliveries
       WHERE project_id = ? AND status = 'DEAD_LETTER'`,
      [projectId]
    );

    const section = async (whereSql: string, params: unknown[] = []): Promise<WorkCandidate[]> => {
      const rows = await this.db.query<WorkRow>(
        `SELECT ${WORK_COLUMNS} FROM work_items
         WHERE project_id = ? AND archived_at IS NULL ${whereSql}
         ORDER BY ${PRIORITY_RANK_SQL} ASC, updated_at DESC, id ASC
         LIMIT ?`,
        [projectId, ...params, perSection]
      );
      return rows.map((row) => candidateFrom(mapWork(row)));
    };

    const [unclaimed, active, waitingOrBlocked, submittedOrReview, stopRequests, reconciliationCandidates] =
      await Promise.all([
        section(`AND state = 'UNCLAIMED'`),
        section(`AND state IN ('CLAIMED', 'IN_PROGRESS')`),
        section(`AND state IN ('WAITING', 'BLOCKED')`),
        section(`AND state IN ('SUBMITTED', 'REVIEW')`),
        section(`AND state <> 'RESOLVED' AND stop_requested_at IS NOT NULL`),
        section(`AND state <> 'RESOLVED' AND reconciliation_deferred = 1`),
      ]);

    return {
      projectId,
      serverTime: Date.now(),
      limits: { perSection },
      counts: {
        unclaimed: countOf(['UNCLAIMED']),
        active: countOf(['CLAIMED', 'IN_PROGRESS']),
        waitingOrBlocked: countOf(['WAITING', 'BLOCKED']),
        submittedOrReview: countOf(['SUBMITTED', 'REVIEW']),
        stopRequests: Number(stopRow?.c ?? 0),
        reconciliationCandidates: Number(reconRow?.c ?? 0),
        resolved: countOf(['RESOLVED']),
        archived: (countMap.get('UNCLAIMED:archived') ?? 0) +
          (countMap.get('CLAIMED:archived') ?? 0) +
          (countMap.get('IN_PROGRESS:archived') ?? 0) +
          (countMap.get('WAITING:archived') ?? 0) +
          (countMap.get('BLOCKED:archived') ?? 0) +
          (countMap.get('SUBMITTED:archived') ?? 0) +
          (countMap.get('REVIEW:archived') ?? 0) +
          (countMap.get('RESOLVED:archived') ?? 0),
      },
      unclaimed,
      active,
      waitingOrBlocked,
      submittedOrReview,
      stopRequests,
      reconciliationCandidates,
      deliveries: {
        unacknowledged: Number(unackedRow?.c ?? 0),
        deadLettered: Number(deadRow?.c ?? 0),
      },
    };
  }

  // ---------------------------------------------------------------------
  // Reference and cycle validation
  // ---------------------------------------------------------------------

  private async assertReferences(projectId: string, workId: string, dependsOn: string[], supersedesWorkId?: string | null): Promise<void> {
    const seen = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [];
    for (const dep of dependsOn) queue.push({ id: dep, depth: 1 });
    if (supersedesWorkId) queue.push({ id: supersedesWorkId, depth: 1 });

    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next.id === workId) {
        throw new SwitchboardError('CONFLICT', `Work '${workId}' cannot reference itself`);
      }
      if (seen.has(next.id) || next.depth > 8) continue;
      seen.add(next.id);
      const row = await this.db.queryFirst<{
        depends_on: string | null;
        replaces_work_id: string | null;
        superseded_by_work_id: string | null;
        state: WorkState;
      }>(
        `SELECT depends_on, replaces_work_id, superseded_by_work_id, state FROM work_items
         WHERE project_id = ? AND id = ?`,
        [projectId, next.id]
      );
      if (!row) {
        throw new SwitchboardError('NOT_FOUND', `Referenced work '${next.id}' was not found in this project`);
      }
      for (const link of [...parseRefs(row.depends_on), row.replaces_work_id, row.superseded_by_work_id]) {
        if (link) queue.push({ id: link, depth: next.depth + 1 });
      }
    }
  }

  private async assertEndpointExists(projectId: string, endpointId: string): Promise<void> {
    const row = await this.db.queryFirst<{ id: string }>(
      `SELECT id FROM endpoints WHERE project_id = ? AND id = ?`,
      [projectId, endpointId]
    );
    if (!row) {
      throw new SwitchboardError('NOT_FOUND', `Endpoint '${endpointId}' was not found in this project`);
    }
  }

  // ---------------------------------------------------------------------
  // Guarded application
  // ---------------------------------------------------------------------

  /**
   * Applies one operation as an atomic, revision-guarded unit: the history row
   * and the state change carry the same predicate, so a stale revision or an
   * authority mismatch writes nothing at all. Outcome is confirmed by reading
   * the durable receipt after commit rather than trusting a driver count.
   */
  private async applyOperation(params: {
    principal: AuthPrincipal;
    work: WorkItem;
    operationId: string;
    expectedRevision: number;
    eventType: WorkEventType;
    toState: WorkState;
    resolutionReason: WorkResolutionReason | null;
    reason: string | null;
    note: string | null;
    evidenceRefs: string[] | null;
    operationHash: string;
    sets: Array<{ sql: string; params: unknown[] }>;
    guard: { sql: string; params: unknown[] };
    /**
     * When true, the guarded mutation additionally requires the current
     * episode-bound handoff for active ownership. Evaluated here for a clean
     * error AND inside the guarded SQL so concurrent handoff/transfer races
     * resolve explicitly instead of silently overwriting.
     */
    enforceHandoff?: boolean;
  }): Promise<WorkReceipt> {
    const { principal, work } = params;
    const now = Date.now();
    const seq = Number(work.lastEventSeq) + 1;
    const resultingRevision = params.expectedRevision + 1;
    const extraSetSql = params.sets.map((set) => `, ${set.sql}`).join('');
    const extraSetParams = params.sets.flatMap((set) => set.params);
    const gated = params.enforceHandoff === true && needsHandoffGate(work);
    if (gated && !handoffSatisfied(work)) {
      throw new SwitchboardError(
        'CONFLICT',
        `Work '${work.id}' needs a current safe handoff before this disposition: record a stop handoff bound to episode ${work.execEpisode} first`,
        {
          details: {
            workId: work.id,
            execEpisode: work.execEpisode,
            stopSeq: work.stopSeq,
            stopOpen: work.stopOpen,
          },
        }
      );
    }
    let guardSql = params.guard.sql;
    let guardParams = [...params.guard.params];
    if (gated) {
      guardSql += ` AND handoff_episode = ? AND handoff_stop_seq = ? AND handoff_by = ?`;
      guardParams.push(work.execEpisode, work.stopSeq, work.executorId);
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO work_events
           (project_id, work_id, seq, event_type, from_state, to_state, actor_id, actor_role,
            reason, note, evidence_refs, operation_id, expected_revision, resulting_revision,
            resulting_resolution_reason, operation_hash, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM work_items
           WHERE project_id = ? AND id = ? AND revision = ? AND last_event_seq = ?
           ${guardSql}
         )`,
        [
          principal.projectId,
          work.id,
          seq,
          params.eventType,
          work.state,
          params.toState,
          principal.endpointId,
          principal.role,
          params.reason,
          params.note,
          serializeRefs(params.evidenceRefs),
          params.operationId,
          params.expectedRevision,
          resultingRevision,
          params.resolutionReason,
          params.operationHash,
          now,
          principal.projectId,
          work.id,
          params.expectedRevision,
          work.lastEventSeq,
          ...guardParams,
        ]
      );

      await tx.execute(
        `UPDATE work_items
           SET state = ?, resolution_reason = ?, revision = revision + 1,
               last_event_seq = last_event_seq + 1, updated_at = ?${extraSetSql}
         WHERE project_id = ? AND id = ? AND revision = ? AND last_event_seq = ?
           ${guardSql}`,
        [
          params.toState,
          params.resolutionReason,
          now,
          ...extraSetParams,
          principal.projectId,
          work.id,
          params.expectedRevision,
          work.lastEventSeq,
          ...guardParams,
        ]
      );
    });

    const event = await this.findEvent(principal.projectId, params.operationId);
    if (!event) {
      const current = await this.loadWork(principal.projectId, work.id);
      throw new SwitchboardError(
        'CONFLICT',
        `Work '${work.id}' was not updated: expected revision ${params.expectedRevision}, current revision ${current.revision} (${current.state})`,
        {
          details: {
            workId: work.id,
            expectedRevision: params.expectedRevision,
            currentRevision: current.revision,
            currentState: current.state,
          },
        }
      );
    }
    const applied = await this.loadWork(principal.projectId, work.id);
    return this.receiptFrom(event, applied, false);
  }

  // ---------------------------------------------------------------------
  // Commissioning
  // ---------------------------------------------------------------------

  async commission(principal: AuthPrincipal, input: unknown): Promise<CommissionWorkResult> {
    this.requireWrite(principal);
    const parsed = CommissionWorkSchema.parse(input);
    const projectId = principal.projectId;
    const now = Date.now();

    const operationHash = await hashOperation({ eventType: 'COMMISSIONED', workId: parsed.id, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      const receipt = await this.checkReplay(principal, replay, operationHash, () => undefined);
      const work = await this.loadWork(projectId, replay.workId);
      return {
        work,
        receipt,
        relatedCandidates: [],
        relatedCandidateCount: 0,
        relatedTruncated: false,
        reconciliationDeferred: work.reconciliationDeferred,
      };
    }

    const existing = await this.db.queryFirst<{ id: string }>(
      `SELECT id FROM work_items WHERE project_id = ? AND id = ?`,
      [projectId, parsed.id]
    );
    if (existing) {
      throw new SwitchboardError('CONFLICT', `Work '${parsed.id}' already exists in this project`, {
        details: { workId: parsed.id },
      });
    }

    const dependsOn = parsed.dependsOn ?? [];
    if (parsed.executorId) await this.assertEndpointExists(projectId, parsed.executorId);
    await this.assertReferences(projectId, parsed.id, dependsOn, parsed.supersedesWorkId ?? null);

    const related = await this.relatedWork(principal, {
      scopeRefs: parsed.scopeRefs,
      objective: parsed.objective,
      threadId: parsed.threadId ?? null,
      limit: 5,
    });

    let superseded: WorkItem | null = null;
    let supersedeGuardSql = '';
    const supersedeGuardParams: unknown[] = [];
    let supersedesExpectedRevision: number | null = null;
    if (parsed.supersedesWorkId) {
      superseded = await this.loadWork(projectId, parsed.supersedesWorkId);
      this.requireCommissionerOrSteward(principal, superseded, 'supersede this work');
      if (superseded.state === 'RESOLVED') {
        throw new SwitchboardError('CONFLICT', `Work '${superseded.id}' is already resolved (${superseded.resolutionReason})`);
      }
      if (this.isSteward(principal) === false && superseded.commissionerId !== principal.endpointId) {
        throw new SwitchboardError('FORBIDDEN', `Only the commissioner of '${superseded.id}' may supersede it`);
      }
      supersedesExpectedRevision = parsed.supersedesExpectedRevision ?? superseded.revision;
      if (supersedesExpectedRevision !== superseded.revision) {
        throw new SwitchboardError(
          'CONFLICT',
          `Work '${superseded.id}' revision conflict: expected ${supersedesExpectedRevision}, current ${superseded.revision}`
        );
      }
      // Supersession closes the old assignment: the same episode-bound
      // handoff gate as resolve applies, enforced both here (clean error)
      // and inside the guarded EXISTS (race-safe). A concurrent handoff or
      // transfer moves the revision and fails the write explicitly instead
      // of closing work behind a stale handoff.
      if (needsHandoffGate(superseded) && !handoffSatisfied(superseded)) {
        throw new SwitchboardError(
          'CONFLICT',
          `Work '${superseded.id}' needs a current safe handoff before it can be superseded: record a stop handoff bound to episode ${superseded.execEpisode} first`,
          { details: { workId: superseded.id, execEpisode: superseded.execEpisode, stopSeq: superseded.stopSeq } }
        );
      }
      const gatedSupersede = needsHandoffGate(superseded);
      supersedeGuardSql = `AND EXISTS (
        SELECT 1 FROM work_items s
        WHERE s.project_id = ? AND s.id = ? AND s.revision = ? AND s.state <> 'RESOLVED'${gatedSupersede ? ' AND s.handoff_episode = ? AND s.handoff_stop_seq = ? AND s.handoff_by = ?' : ''}
      )`;
      supersedeGuardParams.push(projectId, superseded.id, supersedesExpectedRevision);
      if (gatedSupersede) {
        supersedeGuardParams.push(superseded.execEpisode, superseded.stopSeq, superseded.executorId);
      }
    }

    const reconciliationDeferred = !parsed.supersedesWorkId && related.candidates.length > 0;
    const state: WorkState = parsed.executorId ? 'CLAIMED' : 'UNCLAIMED';

    const commissionInsertParams = [
      projectId,
      parsed.id,
      state,
      parsed.priority,
      parsed.objective,
      serializeRefs(parsed.scopeRefs),
      serializeRefs(parsed.acceptanceCriteria),
      serializeRefs(parsed.evidenceRefs),
      serializeRefs(dependsOn),
      principal.endpointId,
      principal.role,
      parsed.executorId ?? null,
      parsed.executorId ? now : null,
      parsed.threadId ?? null,
      parsed.sourceMessageId ?? null,
      superseded ? superseded.id : null,
      reconciliationDeferred ? 1 : 0,
      now,
      now,
    ];

    const supersedeEventOp = `${parsed.operationId}:supersede`;
    const supersedeHash = await hashOperation({ eventType: 'RESOLVED', workId: superseded?.id ?? null, via: parsed.operationId });

    await this.db.transaction(async (tx) => {
      // New work is created only if the supersession prerequisite still holds,
      // so a failed supersession never leaves a half-applied pair behind.
      await tx.execute(
        `INSERT INTO work_items
           (project_id, id, state, priority, objective, scope_refs, acceptance_criteria, evidence_refs,
            depends_on, commissioner_id, commissioner_role, executor_id, claimed_at, thread_id,
            source_message_id, replaces_work_id, reconciliation_deferred, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM work_items WHERE project_id = ? AND id = ?)
           ${supersedeGuardSql}`,
        [...commissionInsertParams, projectId, parsed.id, ...supersedeGuardParams]
      );

      await tx.execute(
        `INSERT INTO work_events
           (project_id, work_id, seq, event_type, from_state, to_state, actor_id, actor_role,
            reason, note, evidence_refs, operation_id, expected_revision, resulting_revision,
            resulting_resolution_reason, operation_hash, created_at)
         SELECT ?, ?, 1, 'COMMISSIONED', NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM work_items WHERE project_id = ? AND id = ? AND revision = 1 AND last_event_seq = 1
         )`,
        [
          projectId,
          parsed.id,
          state,
          principal.endpointId,
          principal.role,
          'COMMISSIONED',
          parsed.note ?? null,
          serializeRefs(parsed.evidenceRefs),
          parsed.operationId,
          operationHash,
          now,
          projectId,
          parsed.id,
        ]
      );

      if (superseded) {
        await tx.execute(
          `INSERT INTO work_events
             (project_id, work_id, seq, event_type, from_state, to_state, actor_id, actor_role,
              reason, note, evidence_refs, operation_id, expected_revision, resulting_revision,
              resulting_resolution_reason, operation_hash, created_at)
           SELECT ?, ?, ?, 'RESOLVED', ?, 'RESOLVED', ?, ?, 'SUPERSEDED', ?, NULL, ?, ?, ?, 'SUPERSEDED', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM work_items
             WHERE project_id = ? AND id = ? AND revision = ? AND state <> 'RESOLVED'
           )`,
          [
            projectId,
            superseded.id,
            superseded.lastEventSeq + 1,
            superseded.state,
            principal.endpointId,
            principal.role,
            parsed.note ?? `Superseded by ${parsed.id}`,
            supersedeEventOp,
            supersedesExpectedRevision,
            superseded.revision + 1,
            supersedeHash,
            now,
            projectId,
            superseded.id,
            supersedesExpectedRevision,
          ]
        );

        await tx.execute(
          `UPDATE work_items
             SET state = 'RESOLVED', resolution_reason = 'SUPERSEDED', resolved_at = ?, resolved_by = ?,
                 superseded_by_work_id = ?, revision = revision + 1,
                 last_event_seq = last_event_seq + 1, updated_at = ?
           WHERE project_id = ? AND id = ? AND revision = ? AND state <> 'RESOLVED'`,
          [now, principal.endpointId, parsed.id, now, projectId, superseded.id, supersedesExpectedRevision]
        );
      }
    });

    const event = await this.findEvent(projectId, parsed.operationId);
    if (!event) {
      const clash = await this.db.queryFirst<{ id: string }>(
        `SELECT id FROM work_items WHERE project_id = ? AND id = ?`,
        [projectId, parsed.id]
      );
      throw new SwitchboardError(
        'CONFLICT',
        clash
          ? `Work '${parsed.id}' already exists in this project`
          : `Work '${parsed.id}' was not commissioned: the supersession target changed or is already resolved`,
        { details: { workId: parsed.id, supersedesWorkId: parsed.supersedesWorkId ?? null } }
      );
    }

    if (superseded) {
      const supersedeEvent = await this.findEvent(projectId, supersedeEventOp);
      if (!supersedeEvent) {
        throw new SwitchboardError(
          'CONFLICT',
          `Work '${parsed.id}' was created but its supersession receipt is missing; reconcile before continuing`,
          { details: { workId: parsed.id, supersedesWorkId: superseded.id } }
        );
      }
    }

    const work = await this.loadWork(projectId, parsed.id);
    return {
      work,
      receipt: this.receiptFrom(event, work, false),
      relatedCandidates: related.candidates,
      relatedCandidateCount: related.outstandingCount,
      relatedTruncated: related.truncated,
      reconciliationDeferred,
    };
  }

  // ---------------------------------------------------------------------
  // Claim and execution
  // ---------------------------------------------------------------------

  async claim(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ClaimWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'CLAIMED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) return await this.checkReplay(principal, replay, operationHash, () => undefined);

    const work = await this.loadWork(projectId, parsed.workId);
    if (work.state !== 'UNCLAIMED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is not available to claim (state ${work.state})`);
    }

    const receipt = await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'CLAIMED',
      operationHash,
      toState: 'CLAIMED',
      resolutionReason: null,
      reason: null,
      note: parsed.note ?? null,
      evidenceRefs: null,
      sets: [
        { sql: 'executor_id = ?', params: [principal.endpointId] },
        { sql: 'claimed_at = COALESCE(claimed_at, ?)', params: [Date.now()] },
        { sql: 'exec_episode = exec_episode + 1', params: [] },
        { sql: 'stop_open = 0', params: [] },
        { sql: 'handoff_episode = NULL', params: [] },
        { sql: 'handoff_stop_seq = NULL', params: [] },
        { sql: 'handoff_by = NULL', params: [] },
      ],
      guard: { sql: `AND state = 'UNCLAIMED'`, params: [] },
    });
    return receipt;
  }

  async transition(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = TransitionWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'STATE_CHANGED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) => {
        const steward = this.isSteward(principal);
        const isExecutor = work.executorId === principal.endpointId;
        const isCommissioner = work.commissionerId === principal.endpointId;
        const commissionerAllowed = parsed.toState === 'REVIEW' || parsed.toState === 'IN_PROGRESS';
        if (!steward && !isExecutor && !(isCommissioner && commissionerAllowed)) {
          throw new SwitchboardError(
            'FORBIDDEN',
            `Only the assigned executor of '' may move it to `
          );
        }
      });
    }

    const work = await this.loadWork(projectId, parsed.workId);
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is resolved; use reopen to authorise further work`);
    }
    const allowed = EXECUTION_TRANSITIONS[work.state] ?? [];
    if (!allowed.includes(parsed.toState)) {
      throw new SwitchboardError(
        'CONFLICT',
        `Work '${work.id}' cannot move from ${work.state} to ${parsed.toState}`,
        { details: { state: work.state, allowed } }
      );
    }

    // The executor drives execution states. A commissioner may accept or request
    // rework but never submits work on the executor's behalf. A steward may
    // reconcile inside this project only.
    const steward = this.isSteward(principal);
    const isExecutor = work.executorId === principal.endpointId;
    const isCommissioner = work.commissionerId === principal.endpointId;
    const commissionerAllowed = parsed.toState === 'REVIEW' || parsed.toState === 'IN_PROGRESS';
    if (!steward && !isExecutor && !(isCommissioner && commissionerAllowed)) {
      throw new SwitchboardError(
        'FORBIDDEN',
        `Only the assigned executor of '${work.id}' may move it to ${parsed.toState}`
      );
    }

    const sets: Array<{ sql: string; params: unknown[] }> = [];
    if (parsed.toState === 'SUBMITTED') sets.push({ sql: 'submitted_at = ?', params: [Date.now()] });
    // Resumed execution invalidates any prior handoff atomically in the same
    // guarded write: execution after the handoff may have changed the partial
    // work the handoff described, so the old binding must not satisfy the gate.
    if (parsed.toState === 'IN_PROGRESS') {
      sets.push({ sql: 'exec_started_episode = exec_episode', params: [] });
      sets.push({ sql: 'handoff_episode = NULL', params: [] });
      sets.push({ sql: 'handoff_stop_seq = NULL', params: [] });
      sets.push({ sql: 'handoff_by = NULL', params: [] });
    }

    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'STATE_CHANGED',
      operationHash,
      toState: parsed.toState,
      resolutionReason: null,
      reason: null,
      note: parsed.note ?? null,
      evidenceRefs: parsed.evidenceRefs ?? null,
      sets,
      guard: {
        sql: `AND state = ? AND state <> 'RESOLVED'`,
        params: [work.state],
      },
    });
  }

  async proposeRelease(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ProposeReleaseSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'RELEASE_PROPOSED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireExecutorOrSteward(principal, work, 'propose release')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireExecutorOrSteward(principal, work, 'propose release');
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved`);
    }

    // An executor may propose release. The obligation is unchanged until the
    // commissioner or a steward accepts it with an explicit disposition.
    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'RELEASE_PROPOSED',
      operationHash,
      toState: work.state,
      resolutionReason: work.resolutionReason,
      reason: 'RELEASE_PROPOSAL',
      note: parsed.note,
      evidenceRefs: null,
      sets: [],
      guard: { sql: `AND state = ? AND state <> 'RESOLVED'`, params: [work.state] },
    });
  }

  // ---------------------------------------------------------------------
  // Stop requests and handoff
  // ---------------------------------------------------------------------

  async requestStop(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = StopRequestSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'STOP_REQUESTED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'request a stop')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'request a stop');
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved`);
    }

    // A stop request is a durable request. It never terminates an external
    // process, discards local work or closes the record by itself.
    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'STOP_REQUESTED',
      operationHash,
      toState: work.state,
      resolutionReason: work.resolutionReason,
      reason: parsed.reason,
      note: parsed.note ?? null,
      evidenceRefs: null,
      sets: [
        { sql: 'stop_requested_at = ?', params: [Date.now()] },
        { sql: 'stop_requested_by = ?', params: [principal.endpointId] },
        { sql: 'stop_reason = ?', params: [parsed.reason] },
        { sql: 'stop_seq = stop_seq + 1', params: [] },
        { sql: 'stop_open = 1', params: [] },
      ],
      guard: { sql: `AND state = ? AND state <> 'RESOLVED'`, params: [work.state] },
    });
  }

  async recordStopHandoff(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = StopHandoffSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'STOP_HANDOFF_RECORDED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireExecutorOrSteward(principal, work, 'record a stop handoff')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireExecutorOrSteward(principal, work, 'record a stop handoff');
    // A handoff answers the open stop of the current episode, or records a
    // proactive handoff for active ownership (bound to the current episode,
    // stop counter and executor). Either way a later stop or episode
    // invalidates it; only the live markers decide, never timestamps.
    const activeOwnership =
      work.executorId !== null && work.state !== 'UNCLAIMED' && work.state !== 'RESOLVED';
    if (!work.stopOpen && !activeOwnership) {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' has no pending stop request to hand off`);
    }
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved`);
    }

    // Partial work is preserved as state + evidence, never discarded.
    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'STOP_HANDOFF_RECORDED',
      operationHash,
      toState: 'WAITING',
      resolutionReason: null,
      reason: 'STOP_HANDOFF',
      note: parsed.note,
      evidenceRefs: parsed.evidenceRefs ?? null,
      sets: [
        { sql: 'stop_handoff_at = ?', params: [Date.now()] },
        { sql: 'handoff_episode = ?', params: [work.execEpisode] },
        { sql: 'handoff_stop_seq = ?', params: [work.stopSeq] },
        { sql: 'handoff_by = ?', params: [principal.endpointId] },
        { sql: 'stop_open = 0', params: [] },
      ],
      guard: { sql: `AND state = ? AND state <> 'RESOLVED'`, params: [work.state] },
    });
  }

  async transfer(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = TransferWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'HANDOFF_TRANSFERRED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'transfer this work')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'transfer this work');
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved; reopen it before transfer`);
    }
    await this.assertEndpointExists(projectId, parsed.toExecutorId);

    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'HANDOFF_TRANSFERRED',
      operationHash,
      enforceHandoff: true,
      toState: work.state === 'UNCLAIMED' ? 'CLAIMED' : work.state,
      resolutionReason: null,
      reason: 'HANDOFF',
      note: parsed.note,
      evidenceRefs: null,
      sets: [
        { sql: 'executor_id = ?', params: [parsed.toExecutorId] },
        { sql: 'claimed_at = COALESCE(claimed_at, ?)', params: [Date.now()] },
        { sql: 'exec_episode = exec_episode + 1', params: [] },
        { sql: 'stop_open = 0', params: [] },
        { sql: 'handoff_episode = NULL', params: [] },
        { sql: 'handoff_stop_seq = NULL', params: [] },
        { sql: 'handoff_by = NULL', params: [] },
        { sql: 'stop_requested_at = NULL', params: [] },
        { sql: 'stop_requested_by = NULL', params: [] },
        { sql: 'stop_reason = NULL', params: [] },
        { sql: 'stop_handoff_at = NULL', params: [] },
      ],
      guard: { sql: `AND state = ? AND state <> 'RESOLVED'`, params: [work.state] },
    });
  }

  /**
   * C3: explicit authorised commissioner handover. The commissioner's
   * responsibility moves without touching the executor, the model or any
   * session: the new commissioner is recorded with authority and receipt,
   * and the prior commissioner stays in history.
   */
  async transferCommissionership(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = TransferCommissionershipSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'COMMISSION_TRANSFERRED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'transfer commissionership')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'transfer commissionership');
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved; reopen it before transfer`);
    }
    await this.assertEndpointExists(projectId, parsed.toCommissionerId);

    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'COMMISSION_TRANSFERRED',
      toState: work.state,
      resolutionReason: work.resolutionReason,
      reason: 'COMMISSION_HANDOFF',
      note: parsed.note,
      evidenceRefs: null,
      operationHash,
      sets: [{ sql: 'commissioner_id = ?', params: [parsed.toCommissionerId] }],
      guard: { sql: `AND state = ? AND state <> 'RESOLVED'`, params: [work.state] },
    });
  }

  /**
   * C4: explicit revision-safe reconciliation disposition. Records what the
   * commissioner decided about deferred related work and clears the marker so
   * the board stops surfacing it. Urgent work may proceed first and reconcile
   * afterwards through this same operation.
   */
  async resolveReconciliation(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ResolveReconciliationSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'RECONCILIATION_RECORDED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'record reconciliation')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'record reconciliation');
    if (!work.reconciliationDeferred) {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' has no deferred reconciliation to record`);
    }

    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'RECONCILIATION_RECORDED',
      toState: work.state,
      resolutionReason: work.resolutionReason,
      reason: parsed.decision,
      note: parsed.note ?? null,
      evidenceRefs: null,
      operationHash,
      sets: [{ sql: 'reconciliation_deferred = 0', params: [] }],
      guard: { sql: `AND state = ? AND reconciliation_deferred = 1`, params: [work.state] },
    });
  }

  // ---------------------------------------------------------------------
  // Resolution, supersession, reopen and archive
  // ---------------------------------------------------------------------

  async resolve(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ResolveWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'RESOLVED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'resolve this work')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'resolve this work');
    if (work.state === 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already resolved (${work.resolutionReason})`);
    }
    // C1 episode gate (Lucy-directed): noncompletion closure of active
    // ownership needs a handoff bound to the current episode, stop request
    // and executor. Accepted completed submission, truly unclaimed work and
    // verified no-start are exempt; everything else is enforced both here
    // (clean error) and inside the guarded mutation (race-safe).
    if (parsed.reason === 'COMPLETED' && !['SUBMITTED', 'REVIEW'].includes(work.state)) {
      throw new SwitchboardError(
        'CONFLICT',
        `Work '${work.id}' must be submitted for acceptance before completion (state ${work.state})`
      );
    }
    if (parsed.reason === 'SUPERSEDED') {
      const replacementId = parsed.replacementWorkId!;
      if (replacementId === work.id) {
        throw new SwitchboardError('INVALID_INPUT', 'A work item cannot supersede itself');
      }
      await this.assertReferences(projectId, work.id, [], replacementId);
      const replacement = await this.loadWork(projectId, replacementId);
      if (replacement.state === 'RESOLVED') {
        throw new SwitchboardError('CONFLICT', `Replacement '${replacementId}' is already resolved and cannot supersede work`);
      }
    }

    const sets: Array<{ sql: string; params: unknown[] }> = [
      { sql: 'resolved_at = ?', params: [Date.now()] },
      { sql: 'resolved_by = ?', params: [principal.endpointId] },
    ];
    let guardSql = `AND state = ? AND state <> 'RESOLVED'`;
    const guardParams: unknown[] = [work.state];
    if (parsed.reason === 'SUPERSEDED') {
      sets.push({ sql: 'superseded_by_work_id = ?', params: [parsed.replacementWorkId!] });
      guardSql += ` AND EXISTS (
        SELECT 1 FROM work_items r
        WHERE r.project_id = ? AND r.id = ? AND r.state <> 'RESOLVED'
      )`;
      guardParams.push(projectId, parsed.replacementWorkId!);
    }

    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'RESOLVED',
      operationHash,
      enforceHandoff: parsed.reason !== 'COMPLETED',
      toState: 'RESOLVED',
      resolutionReason: parsed.reason,
      reason: parsed.reason,
      note: parsed.note ?? null,
      evidenceRefs: parsed.evidenceRefs ?? null,
      sets,
      guard: { sql: guardSql, params: guardParams },
    });
  }

  async supersede(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    const parsed = SupersedeWorkSchema.parse(input);
    return await this.resolve(principal, {
      workId: parsed.workId,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      reason: 'SUPERSEDED',
      replacementWorkId: parsed.replacementWorkId,
      note: parsed.note,
    });
  }

  async reopen(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ReopenWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'REOPENED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'reopen this work')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'reopen this work');
    if (work.state !== 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is not resolved (state ${work.state})`);
    }

    const targetState: WorkState = work.executorId ? 'CLAIMED' : 'UNCLAIMED';
    // The prior resolution stays in history; only the live row is reopened.
    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'REOPENED',
      operationHash,
      toState: targetState,
      resolutionReason: null,
      reason: parsed.reason,
      note: `Reopened from ${work.resolutionReason ?? 'RESOLVED'}`,
      evidenceRefs: null,
      sets: [
        { sql: 'resolved_at = NULL', params: [] },
        { sql: 'resolved_by = NULL', params: [] },
        { sql: 'archived_at = NULL', params: [] },
        { sql: 'reconciliation_deferred = 0', params: [] },
        { sql: 'exec_episode = exec_episode + 1', params: [] },
        { sql: 'stop_open = 0', params: [] },
        { sql: 'handoff_episode = NULL', params: [] },
        { sql: 'handoff_stop_seq = NULL', params: [] },
        { sql: 'handoff_by = NULL', params: [] },
        { sql: 'stop_requested_at = NULL', params: [] },
        { sql: 'stop_requested_by = NULL', params: [] },
        { sql: 'stop_reason = NULL', params: [] },
        { sql: 'stop_handoff_at = NULL', params: [] },
      ],
      guard: { sql: `AND state = 'RESOLVED'`, params: [] },
    });
  }

  async archive(principal: AuthPrincipal, input: unknown): Promise<WorkReceipt> {
    this.requireWrite(principal);
    const parsed = ArchiveWorkSchema.parse(input);
    const projectId = principal.projectId;
    const operationHash = await hashOperation({ eventType: 'ARCHIVED', workId: parsed.workId, input: { ...parsed, operationId: undefined } });
    const replay = await this.findEvent(projectId, parsed.operationId);
    if (replay) {
      return await this.checkReplay(principal, replay, operationHash, (work) =>
        this.requireCommissionerOrSteward(principal, work, 'archive this work')
      );
    }

    const work = await this.loadWork(projectId, parsed.workId);
    this.requireCommissionerOrSteward(principal, work, 'archive this work');
    if (work.state !== 'RESOLVED') {
      throw new SwitchboardError('CONFLICT', `Only resolved work can be archived (state ${work.state})`);
    }
    if (work.archivedAt) {
      throw new SwitchboardError('CONFLICT', `Work '${work.id}' is already archived`);
    }

    // Logical archival only: the record, its evidence and its history remain.
    return await this.applyOperation({
      principal,
      work,
      operationId: parsed.operationId,
      expectedRevision: parsed.expectedRevision,
      eventType: 'ARCHIVED',
      operationHash,
      toState: 'RESOLVED',
      resolutionReason: work.resolutionReason,
      reason: 'ARCHIVED',
      note: null,
      evidenceRefs: null,
      sets: [{ sql: 'archived_at = ?', params: [Date.now()] }],
      guard: { sql: `AND state = 'RESOLVED' AND archived_at IS NULL`, params: [] },
    });
  }
}

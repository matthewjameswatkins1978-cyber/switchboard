import type { EndpointRole, Priority } from '../core/types.js';

/**
 * SWB-SWEEP-001 work semantics.
 *
 * This layer is deliberately narrow. It records who owns an obligation and what
 * happened to it. It never claims that an external process started, stopped or
 * finished, and it never infers completion from presence, age or delivery state.
 */

export type WorkState =
  | 'UNCLAIMED'
  | 'CLAIMED'
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'BLOCKED'
  | 'SUBMITTED'
  | 'REVIEW'
  | 'RESOLVED';

/**
 * Terminal reasons stay distinguishable for the whole life of the record so an
 * auditor can tell "finished" from "no longer wanted" from "replaced by X".
 */
export type WorkResolutionReason =
  | 'COMPLETED'
  | 'SUPERSEDED'
  | 'OBSOLETE'
  | 'CANCELLED'
  | 'DUPLICATE';

export type WorkEventType =
  | 'COMMISSIONED'
  | 'CLAIMED'
  | 'STATE_CHANGED'
  | 'STOP_REQUESTED'
  | 'STOP_HANDOFF_RECORDED'
  | 'RELEASE_PROPOSED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'ARCHIVED'
  | 'HANDOFF_TRANSFERRED'
  | 'RECONCILIATION_RECORDED'
  | 'COMMISSION_TRANSFERRED';

export interface WorkItem {
  projectId: string;
  id: string;
  state: WorkState;
  resolutionReason: WorkResolutionReason | null;
  priority: Priority;
  objective: string;
  scopeRefs: string[];
  acceptanceCriteria: string[];
  evidenceRefs: string[];
  dependsOn: string[];
  commissionerId: string;
  commissionerRole: EndpointRole;
  executorId: string | null;
  claimedAt: number | null;
  submittedAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  threadId: string | null;
  sourceMessageId: string | null;
  replacesWorkId: string | null;
  supersededByWorkId: string | null;
  stopRequestedAt: number | null;
  stopRequestedBy: string | null;
  stopReason: string | null;
  stopHandoffAt: number | null;
  /** Execution episode: bumped on claim, transfer and reopen. Handoff markers belong to exactly one episode. */
  execEpisode: number;
  /** Monotonic stop-request counter; a new request invalidates any prior handoff binding. */
  stopSeq: number;
  /** 1 while a stop request of the current episode awaits a handoff. */
  stopOpen: boolean;
  /** Episode the accepted handoff belongs to; must equal execEpisode to satisfy the gate. */
  handoffEpisode: number | null;
  /** Stop request the accepted handoff answers; must equal stopSeq. */
  handoffStopSeq: number | null;
  /** Executor (or steward) that recorded the accepted handoff; must equal the current executor. */
  handoffBy: string | null;
  /** Episode in which execution first entered IN_PROGRESS; NULL means verified no-start. */
  execStartedEpisode: number | null;
  reconciliationDeferred: boolean;
  archivedAt: number | null;
  revision: number;
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkEvent {
  projectId: string;
  workId: string;
  seq: number;
  eventType: WorkEventType;
  fromState: WorkState | null;
  toState: WorkState;
  actorId: string;
  actorRole: EndpointRole;
  reason: string | null;
  note: string | null;
  evidenceRefs: string[];
  operationId: string;
  expectedRevision: number | null;
  resultingRevision: number;
  /** Reason snapshotted at commit time; unlike live work state, this never drifts. */
  resultingResolutionReason: WorkResolutionReason | null;
  /** Binds the operation id to its canonical content; a replay with different content conflicts. */
  operationHash: string | null;
  createdAt: number;
}

/** A durable, replay-safe receipt for one accepted work operation. */
export interface WorkReceipt {
  operationId: string;
  workId: string;
  eventSeq: number;
  eventType: WorkEventType;
  state: WorkState;
  resolutionReason: WorkResolutionReason | null;
  revision: number;
  actorId: string;
  at: number;
  isReplay: boolean;
}

/** Concise candidate shown to a commissioner. Deliberately small. */
export interface WorkCandidate {
  workId: string;
  state: WorkState;
  priority: Priority;
  objective: string;
  revision: number;
  updatedAt: number;
  matchReasons: string[];
  resolutionReason?: WorkResolutionReason | null;
  supersededByWorkId?: string | null;
  evidenceRefs?: string[];
}

export interface CommissionWorkResult {
  work: WorkItem;
  receipt: WorkReceipt;
  /** Bounded related outstanding work the commissioner has authority over. */
  relatedCandidates: WorkCandidate[];
  relatedCandidateCount: number;
  /** True when related work exists beyond the returned candidates. */
  relatedTruncated: boolean;
  /** True when this commission did not reconcile the related candidates. */
  reconciliationDeferred: boolean;
}

export type ReconciliationDecision = 'retained' | 'reprioritised' | 'combined' | 'superseded' | 'withdrawn' | 'cancelled' | 'referred';

export interface RelatedWorkResult {
  candidates: WorkCandidate[];
  /** Total outstanding work under the same filters, uncapped. Never silently truncated. */
  outstandingCount: number;
  /** True when outstanding work exists beyond the returned candidates. */
  truncated: boolean;
}

export interface WorkListResult {
  items: WorkCandidate[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WorkDetail {
  work: WorkItem;
  events: WorkEvent[];
  historyTruncated: boolean;
}

export interface WorkBoard {
  projectId: string;
  serverTime: number;
  limits: { perSection: number };
  counts: {
    unclaimed: number;
    active: number;
    waitingOrBlocked: number;
    submittedOrReview: number;
    stopRequests: number;
    reconciliationCandidates: number;
    resolved: number;
    archived: number;
  };
  unclaimed: WorkCandidate[];
  active: WorkCandidate[];
  waitingOrBlocked: WorkCandidate[];
  submittedOrReview: WorkCandidate[];
  stopRequests: WorkCandidate[];
  reconciliationCandidates: WorkCandidate[];
  /** Transport state stays separate from work state. */
  deliveries: { unacknowledged: number; deadLettered: number };
}

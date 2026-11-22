export type Priority = 'urgent' | 'normal' | 'low';
export type RecipientType = 'endpoint' | 'channel';
export type DeliveryStatus = 'STORED' | 'RECEIVED' | 'ACKNOWLEDGED';
export type EndpointState = 'available' | 'busy' | 'waiting' | 'stale' | 'offline';
export type EndpointRole = 'agent' | 'service' | 'human' | 'admin';

export interface AuthPrincipal {
  endpointId: string;
  projectId: string;
  scopes: string[];
  role: EndpointRole;
}

export interface StoredMessage {
  internalId?: number;
  id: string; // client-provided message_id (scoped to sender+project)
  senderId: string;
  projectId: string;
  recipientType: RecipientType;
  recipientId: string;
  kind: string;
  subject: string;
  payload: string; // JSON serialized string
  payloadHash: string; // SHA-256 of payload
  envelopeHash: string; // SHA-256 of full immutable envelope
  priority: Priority;
  threadId: string | null;
  replyToId: string | null;
  evidenceRefs: string[] | null;
  createdAt: number; // server epoch ms
}

export interface MessageEnvelope {
  id: string;
  senderId: string;
  projectId: string;
  recipientType: RecipientType;
  recipientId: string;
  kind: string;
  subject: string;
  payload: unknown;
  priority: Priority;
  threadId?: string | null;
  replyToId?: string | null;
  evidenceRefs?: string[] | null;
  serverCreatedAt: number;
  deliverySequence: number;
  deliveryStatus: DeliveryStatus;
  acknowledgedAt?: number | null;
}

export interface StoredReceipt {
  messageId: string;
  senderId: string;
  status: 'STORED';
  acceptedAt: number;
  recipientCount: number;
  isDuplicate?: boolean;
}

export interface AckReceipt {
  messageId: string;
  senderId: string;
  recipientId: string;
  status: 'ACKNOWLEDGED';
  acknowledgedAt: number;
}

export interface EndpointStatusRecord {
  endpointId: string;
  projectId: string;
  state: EndpointState;
  description: string | null;
  revision: number;
  lastHeartbeatAt: number;
  updatedAt: number;
  updatedBy: string;
  isStale?: boolean;
}

export interface SyncRequest {
  sinceCursor?: string;
  limit?: number; // max 32
  includeAcknowledged?: boolean;
  outgoingMessages?: OutgoingMessageInput[];
  acknowledgements?: AckInput[];
  statusUpdate?: StatusUpdateInput;
}

export interface OutgoingMessageInput {
  id: string; // client idempotency key
  recipientType: RecipientType;
  recipientId: string;
  kind: string;
  subject: string;
  payload: unknown; // serialized JSON, max 32 KiB
  priority?: Priority;
  threadId?: string | null;
  replyToId?: string | null;
  evidenceRefs?: string[] | null;
}

export interface AckInput {
  messageId: string;
  senderId: string;
  note?: string;
}

export interface StatusUpdateInput {
  state: EndpointState;
  description?: string | null;
  expectedRevision?: number; // optimistic concurrency check
}

export interface SyncItemError {
  id: string;
  code: string;
  message: string;
}

export interface SyncResponse {
  storedReceipts: StoredReceipt[];
  acknowledgedReceipts: AckReceipt[];
  inboundMessages: MessageEnvelope[];
  errors: SyncItemError[];
  cursor: string;
  hasMore: boolean;
  serverTime: number;
  recommendedNextSyncMs: number;
}

export interface BoardSummary {
  projectId: string;
  serverTime: number;
  endpoints: EndpointStatusRecord[];
  unackedCount: number;
  recentMessages: MessageEnvelope[];
  recentErrors: Array<{ id: number; action: string; details: string; createdAt: number }>;
}

export interface ExportData {
  version: string;
  exportedAt: number;
  projectId: string;
  projects: Array<{ id: string; name: string; createdAt: number }>;
  endpoints: Array<{ id: string; projectId: string; name: string; role: EndpointRole; createdAt: number }>;
  channels: Array<{ id: string; projectId: string; name: string; createdAt: number }>;
  channelMembers: Array<{ channelId: string; endpointId: string; joinedAt: number }>;
  messages: StoredMessage[];
  deliveries: Array<{
    id: number;
    projectId: string;
    messageId: string;
    senderId: string;
    recipientId: string;
    channelId: string | null;
    sequence: number;
    status: DeliveryStatus;
    deliveredAt: number;
    receivedAt: number | null;
    acknowledgedAt: number | null;
    acknowledgementNote: string | null;
  }>;
  statuses: EndpointStatusRecord[];
  checksumSha256: string;
}

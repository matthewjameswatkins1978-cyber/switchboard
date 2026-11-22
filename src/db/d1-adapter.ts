import type { DatabaseSession, ExecResult } from './database.js';

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[]; success: boolean; meta?: any }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number | bigint } }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ results?: T[]; success: boolean; meta?: any }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export class D1TransactionSession implements DatabaseSession {
  private d1: D1DatabaseLike;
  private stagedStatements: D1PreparedStatement[] = [];

  // Transactional visibility buffers for staged mutations
  private stagedMaxSequence: Map<string, number> = new Map();
  private stagedMessages: Map<string, any> = new Map();
  private stagedStatuses: Map<string, any> = new Map();

  constructor(d1: D1DatabaseLike) {
    this.d1 = d1;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const res = await stmt.all<T>();
    return res.results ?? [];
  }

  async queryFirst<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    // 1. Transactional visibility: MAX(sequence)
    if (normalized.includes('MAX_SEQ') || (normalized.includes('MAX(SEQUENCE)') && normalized.includes('MESSAGE_DELIVERIES'))) {
      const stmt = this.d1.prepare(sql).bind(...params);
      const row = await stmt.first<any>();
      const dbMax = row?.max_seq ? Number(row.max_seq) : 0;

      const projectId = String(params[0] ?? '');
      const recipientId = String(params[1] ?? '');
      const key = `${projectId}:${recipientId}`;
      const stagedMax = this.stagedMaxSequence.get(key) ?? 0;

      const effectiveMax = Math.max(dbMax, stagedMax);
      return { max_seq: effectiveMax > 0 ? effectiveMax : null } as unknown as T;
    }

    // 2. Transactional visibility: messages check
    if (normalized.includes('FROM MESSAGES') && normalized.includes('PROJECT_ID =') && normalized.includes('SENDER_ID =') && normalized.includes('ID =')) {
      const projectId = String(params[0] ?? '');
      const senderId = String(params[1] ?? '');
      const messageId = String(params[2] ?? '');
      const key = `${projectId}:${senderId}:${messageId}`;
      const staged = this.stagedMessages.get(key);
      if (staged) return staged as T;
    }

    // 3. Transactional visibility: endpoint_status check
    if (normalized.includes('FROM ENDPOINT_STATUS') && normalized.includes('ENDPOINT_ID =') && normalized.includes('PROJECT_ID =')) {
      const endpointId = String(params[0] ?? '');
      const projectId = String(params[1] ?? '');
      const key = `${projectId}:${endpointId}`;
      const staged = this.stagedStatuses.get(key);
      if (staged) return staged as T;
    }

    const stmt = this.d1.prepare(sql).bind(...params);
    const row = await stmt.first<T>();
    return row ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const stmt = this.d1.prepare(sql).bind(...params);
    this.stagedStatements.push(stmt);

    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

    // Track staged delivery sequences for transactional visibility
    if (normalized.startsWith('INSERT INTO MESSAGE_DELIVERIES')) {
      // params: [projectId, messageId, senderId, recipientId, channelId, sequence, status, deliveredAt, ...]
      const projectId = String(params[0] ?? '');
      const recipientId = String(params[3] ?? '');
      const sequence = Number(params[5] ?? 0);
      const key = `${projectId}:${recipientId}`;
      const current = this.stagedMaxSequence.get(key) ?? 0;
      if (sequence > current) {
        this.stagedMaxSequence.set(key, sequence);
      }
    }

    if (normalized.includes('ENDPOINT_SEQUENCES')) {
      const projectId = String(params[0] ?? '');
      const recipientId = String(params[1] ?? '');
      const sequence = Number(params[2] ?? 0);
      const key = `${projectId}:${recipientId}`;
      const current = this.stagedMaxSequence.get(key) ?? 0;
      if (sequence > current) {
        this.stagedMaxSequence.set(key, sequence);
      }
    }

    // Track staged messages for transactional visibility
    if (normalized.startsWith('INSERT INTO MESSAGES')) {
      // params: [id, senderId, projectId, recipientType, recipientId, kind, subject, payload, payloadHash, envelopeHash, priority, threadId, replyToId, evidenceRefs, now]
      const id = String(params[0] ?? '');
      const senderId = String(params[1] ?? '');
      const projectId = String(params[2] ?? '');
      const payloadHash = String(params[8] ?? '');
      const envelopeHash = String(params[9] ?? '');
      const createdAt = Number(params[14] ?? Date.now());
      const key = `${projectId}:${senderId}:${id}`;
      this.stagedMessages.set(key, {
        id,
        sender_id: senderId,
        project_id: projectId,
        payload_hash: payloadHash,
        envelope_hash: envelopeHash,
        created_at: createdAt,
      });
    }

    // Track staged endpoint status
    if (normalized.includes('ENDPOINT_STATUS') && (normalized.startsWith('INSERT INTO') || normalized.startsWith('UPDATE'))) {
      const endpointId = String(params[0] ?? '');
      const projectId = String(params[1] ?? '');
      const key = `${projectId}:${endpointId}`;
      const current = this.stagedStatuses.get(key);
      const rev = current ? current.revision + 1 : 2;
      this.stagedStatuses.set(key, {
        endpoint_id: endpointId,
        project_id: projectId,
        revision: rev,
      });
    }

    return {
      changes: 1,
      rowsWritten: 1,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }

  async transaction<T>(fn: (tx: DatabaseSession) => Promise<T>): Promise<T> {
    return await fn(this);
  }

  async commit(): Promise<void> {
    if (this.stagedStatements.length > 0) {
      await this.d1.batch(this.stagedStatements);
      this.stagedStatements = [];
      this.stagedMaxSequence.clear();
      this.stagedMessages.clear();
      this.stagedStatuses.clear();
    }
  }

  rollback(): void {
    this.stagedStatements = [];
    this.stagedMaxSequence.clear();
    this.stagedMessages.clear();
    this.stagedStatuses.clear();
  }
}

export class D1Adapter implements DatabaseSession {
  private d1: D1DatabaseLike;

  constructor(d1: D1DatabaseLike) {
    this.d1 = d1;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const res = await stmt.all<T>();
    return res.results ?? [];
  }

  async queryFirst<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const row = await stmt.first<T>();
    return row ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const stmt = this.d1.prepare(sql).bind(...params);
    const res = await stmt.run();
    return {
      changes: res.meta?.changes ?? 0,
      lastInsertRowid: res.meta?.last_row_id,
      rowsWritten: res.meta?.changes ?? 0,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.d1.exec(sql);
  }

  async transaction<T>(fn: (tx: DatabaseSession) => Promise<T>): Promise<T> {
    const session = new D1TransactionSession(this.d1);
    try {
      const result = await fn(session);
      await session.commit();
      return result;
    } catch (err) {
      session.rollback();
      throw err;
    }
  }
}

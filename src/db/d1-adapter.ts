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

class D1TransactionSession implements DatabaseSession {
  private d1: D1DatabaseLike;
  private stagedStatements: D1PreparedStatement[] = [];

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
    this.stagedStatements.push(stmt);
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
    }
  }

  rollback(): void {
    this.stagedStatements = [];
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

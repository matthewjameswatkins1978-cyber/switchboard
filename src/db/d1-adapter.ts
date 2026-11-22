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
    // Note: D1 does not support nested BEGIN/COMMIT outside of batch(),
    // but runs statements sequentially. For explicit batches, D1 batch is used.
    // In Worker context, batch or sequential queries operate against the bound D1 instance.
    return await fn(this);
  }
}

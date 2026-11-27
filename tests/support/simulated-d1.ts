import { DatabaseSync } from 'node:sqlite';
import type { D1DatabaseLike, D1PreparedStatement } from '../../src/db/d1-adapter.js';

/**
 * Minimal D1-shaped test double backed by a real SQLite database.
 *
 * It deliberately offers only the D1 surface (prepare/bind/first/all/run/batch/exec)
 * so adapter code cannot rely on Node-only shortcuts. Tests share it rather than
 * each re-implementing storage semantics.
 */
export function createSimulatedD1(): D1DatabaseLike & { raw: DatabaseSync } {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON;');

  const makeStmt = (query: string, boundParams: unknown[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return makeStmt(query, values);
    },
    async first<T = unknown>(_colName?: string): Promise<T | null> {
      const stmt = rawDb.prepare(query);
      const res = stmt.get(...(boundParams as never[]));
      return (res ?? null) as T | null;
    },
    async all<T = unknown>(): Promise<{ results?: T[]; success: boolean; meta?: unknown }> {
      const stmt = rawDb.prepare(query);
      const res = stmt.all(...(boundParams as never[]));
      return { results: res as unknown as T[], success: true, meta: {} };
    },
    async run(): Promise<{ success: boolean; meta?: { changes?: number; last_row_id?: number | bigint } }> {
      const stmt = rawDb.prepare(query);
      const res = stmt.run(...(boundParams as never[]));
      return { success: true, meta: { changes: Number(res.changes), last_row_id: res.lastInsertRowid } };
    },
  });

  return {
    prepare(query: string) {
      return makeStmt(query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const results: Array<{ results?: T[]; success: boolean; meta?: unknown }> = [];
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      return results;
    },
    async exec(query: string) {
      rawDb.exec(query);
      return { count: 1, duration: 1 };
    },
    raw: rawDb,
  };
}

import { DatabaseSync } from 'node:sqlite';
import type { DatabaseSession, ExecResult } from './database.js';

export class SqliteAdapter implements DatabaseSession {
  private db: DatabaseSync;
  private transactionMutex: Promise<void> = Promise.resolve();
  private activeTransactionDepth = 0;

  constructor(location: string = ':memory:') {
    this.db = new DatabaseSync(location);
    if (location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private async acquireLock(): Promise<() => void> {
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentLock = this.transactionMutex;
    this.transactionMutex = currentLock.then(() => nextLock);
    await currentLock;
    return release;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...(params as any[]));
    return rows as unknown as T[];
  }

  async queryFirst<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...(params as any[]));
    if (row === undefined || row === null) return null;
    return row as unknown as T;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...(params as any[]));
    return {
      changes: Number(res.changes),
      lastInsertRowid: res.lastInsertRowid,
      rowsWritten: Number(res.changes),
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DatabaseSession) => Promise<T>): Promise<T> {
    if (this.activeTransactionDepth > 0) {
      // True nested transaction using SQLite SAVEPOINT
      const spName = `sp_${this.activeTransactionDepth}`;
      this.activeTransactionDepth++;
      this.db.exec(`SAVEPOINT ${spName}`);
      try {
        const result = await fn(this);
        this.db.exec(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (err) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
          this.db.exec(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // Ignore secondary savepoint rollback error
        }
        throw err;
      } finally {
        this.activeTransactionDepth--;
      }
    }

    // Top-level transaction: acquire mutex to serialize concurrent transaction calls
    const releaseLock = await this.acquireLock();
    this.activeTransactionDepth = 1;
    this.db.exec('BEGIN IMMEDIATE');

    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure if already rolled back
      }
      throw err;
    } finally {
      this.activeTransactionDepth = 0;
      releaseLock();
    }
  }

  close(): void {
    this.db.close();
  }
}

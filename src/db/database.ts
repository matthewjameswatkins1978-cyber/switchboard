export interface ExecResult {
  changes: number;
  lastInsertRowid?: number | bigint;
  rowsWritten?: number;
}

export interface DatabaseSession {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryFirst<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<ExecResult>;
  transaction<T>(fn: (tx: DatabaseSession) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close?(): Promise<void> | void;
}

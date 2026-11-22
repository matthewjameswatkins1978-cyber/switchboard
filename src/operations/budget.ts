import type { DatabaseSession } from '../db/database.js';
import { SwitchboardError } from '../core/errors.js';

export type BudgetStatusLevel =
  | 'HEALTHY'
  | 'WARNING_50'
  | 'WARNING_75'
  | 'THROTTLE_90'
  | 'EXCEEDED_100';

export interface ProjectBudgetLimits {
  maxRequests: number;
  maxRowsWritten: number;
  maxStorageBytes: number;
}

export interface BudgetReport {
  projectId: string;
  cycleStartAt: number;
  requestCount: number;
  rowsRead: number;
  rowsWritten: number;
  storageBytes: number;
  limits: ProjectBudgetLimits;
  percentRequests: number;
  percentRowsWritten: number;
  percentStorage: number;
  highestPercent: number;
  status: BudgetStatusLevel;
  cadenceMultiplier: number;
}

export const DEFAULT_BUDGET_LIMITS: ProjectBudgetLimits = {
  maxRequests: 3_000_000, // Cloudflare Workers Free: 100,000/day * 30 days
  maxRowsWritten: 3_000_000, // Cloudflare D1 Free: 100,000/day * 30 days
  maxStorageBytes: 500_000_000, // 500 MB safe D1 database allocation
};

export const CYCLE_DURATION_MS = 30 * 86_400_000; // 30-day accounting cycle

export class BudgetManager {
  private static instance: BudgetManager;

  static getInstance(): BudgetManager {
    if (!BudgetManager.instance) {
      BudgetManager.instance = new BudgetManager();
    }
    return BudgetManager.instance;
  }

  async getReport(db: DatabaseSession, projectId: string): Promise<BudgetReport> {
    const now = Date.now();
    const row = await db.queryFirst<{
      cycle_start_at: number;
      request_count: number;
      rows_read: number;
      rows_written: number;
      storage_bytes: number;
      max_requests: number;
      max_rows_written: number;
      max_storage_bytes: number;
    }>(
      `SELECT cycle_start_at, request_count, rows_read, rows_written, storage_bytes,
              max_requests, max_rows_written, max_storage_bytes
       FROM usage_accounting WHERE project_id = ?`,
      [projectId]
    );

    const limits: ProjectBudgetLimits = {
      maxRequests: row?.max_requests ?? DEFAULT_BUDGET_LIMITS.maxRequests,
      maxRowsWritten: row?.max_rows_written ?? DEFAULT_BUDGET_LIMITS.maxRowsWritten,
      maxStorageBytes: row?.max_storage_bytes ?? DEFAULT_BUDGET_LIMITS.maxStorageBytes,
    };

    let cycleStartAt = row?.cycle_start_at ?? now;
    let requestCount = row?.request_count ?? 0;
    let rowsRead = row?.rows_read ?? 0;
    let rowsWritten = row?.rows_written ?? 0;
    const storageBytes = row?.storage_bytes ?? 0;

    // Automatic cycle rollover: reset accounting counters when period expires
    if (now - cycleStartAt >= CYCLE_DURATION_MS) {
      cycleStartAt = now;
      requestCount = 0;
      rowsRead = 0;
      rowsWritten = 0;

      await db.execute(
        `UPDATE usage_accounting
         SET cycle_start_at = ?, request_count = 0, rows_read = 0, rows_written = 0, updated_at = ?
         WHERE project_id = ?`,
        [now, now, projectId]
      );
    }

    const percentRequests = Math.round((requestCount / limits.maxRequests) * 100);
    const percentRowsWritten = Math.round((rowsWritten / limits.maxRowsWritten) * 100);
    const percentStorage = Math.round((storageBytes / limits.maxStorageBytes) * 100);
    const highestPercent = Math.max(percentRequests, percentRowsWritten, percentStorage);

    let status: BudgetStatusLevel = 'HEALTHY';
    let cadenceMultiplier = 1.0;

    if (highestPercent >= 100) {
      status = 'EXCEEDED_100';
      cadenceMultiplier = 3.0;
    } else if (highestPercent >= 90) {
      status = 'THROTTLE_90';
      cadenceMultiplier = 2.0;
    } else if (highestPercent >= 75) {
      status = 'WARNING_75';
      cadenceMultiplier = 1.5;
    } else if (highestPercent >= 50) {
      status = 'WARNING_50';
      cadenceMultiplier = 1.2;
    }

    return {
      projectId,
      cycleStartAt,
      requestCount,
      rowsRead,
      rowsWritten,
      storageBytes,
      limits,
      percentRequests,
      percentRowsWritten,
      percentStorage,
      highestPercent,
      status,
      cadenceMultiplier,
    };
  }

  async recordUsage(
    db: DatabaseSession,
    projectId: string,
    delta: { requests?: number; rowsRead?: number; rowsWritten?: number; storageBytes?: number }
  ): Promise<void> {
    const now = Date.now();
    const req = delta.requests ?? 0;
    const read = delta.rowsRead ?? 0;
    const written = delta.rowsWritten ?? 0;
    const storage = delta.storageBytes ?? 0;

    // Check if existing accounting cycle has expired
    const existing = await db.queryFirst<{ cycle_start_at: number }>(
      `SELECT cycle_start_at FROM usage_accounting WHERE project_id = ?`,
      [projectId]
    );

    if (existing && now - existing.cycle_start_at >= CYCLE_DURATION_MS) {
      await db.execute(
        `UPDATE usage_accounting
         SET cycle_start_at = ?, request_count = 0, rows_read = 0, rows_written = 0, updated_at = ?
         WHERE project_id = ?`,
        [now, now, projectId]
      );
    }

    await db.execute(
      `INSERT INTO usage_accounting
       (project_id, cycle_start_at, request_count, rows_read, rows_written, storage_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         request_count = usage_accounting.request_count + excluded.request_count,
         rows_read = usage_accounting.rows_read + excluded.rows_read,
         rows_written = usage_accounting.rows_written + excluded.rows_written,
         storage_bytes = CASE WHEN excluded.storage_bytes > 0 THEN excluded.storage_bytes ELSE usage_accounting.storage_bytes END,
         updated_at = excluded.updated_at`,
      [projectId, now, req, read, written, storage, now]
    );
  }

  async enforceBudget(db: DatabaseSession, projectId: string, isUrgent = false): Promise<BudgetReport> {
    const report = await this.getReport(db, projectId);
    if (report.status === 'EXCEEDED_100' && !isUrgent) {
      throw new SwitchboardError(
        'THROTTLED',
        `Monthly resource budget for project '${projectId}' exceeded (${report.highestPercent}%). Throttling non-urgent operations.`,
        { retryAfterSeconds: 3600 }
      );
    }
    return report;
  }

  async setLimits(db: DatabaseSession, projectId: string, limits: Partial<ProjectBudgetLimits>): Promise<void> {
    const now = Date.now();
    const existing = await this.getReport(db, projectId);
    const updatedLimits: ProjectBudgetLimits = {
      maxRequests: limits.maxRequests ?? existing.limits.maxRequests,
      maxRowsWritten: limits.maxRowsWritten ?? existing.limits.maxRowsWritten,
      maxStorageBytes: limits.maxStorageBytes ?? existing.limits.maxStorageBytes,
    };

    await db.execute(
      `INSERT INTO usage_accounting
       (project_id, cycle_start_at, max_requests, max_rows_written, max_storage_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         max_requests = excluded.max_requests,
         max_rows_written = excluded.max_rows_written,
         max_storage_bytes = excluded.max_storage_bytes,
         updated_at = excluded.updated_at`,
      [
        projectId,
        now,
        updatedLimits.maxRequests,
        updatedLimits.maxRowsWritten,
        updatedLimits.maxStorageBytes,
        now,
      ]
    );
  }
}

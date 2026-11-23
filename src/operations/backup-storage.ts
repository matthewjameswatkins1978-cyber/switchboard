import fs from 'node:fs/promises';
import path from 'node:path';
import type { BackupRecord } from '../core/types.js';

export type BackupStorageType = 'local_external' | 'hosted_database';

export interface BackupStorage {
  saveBackup(record: BackupRecord): Promise<void>;
  loadBackup(backupId: string, projectId: string): Promise<BackupRecord | null>;
  listBackups(projectId: string): Promise<Array<Omit<BackupRecord, 'manifestJson'>>>;
}

/**
 * Local filesystem backup storage for self-hosted Node.js deployments.
 * Stores atomic JSON backup snapshots outside the primary SQLite database.
 */
export class FileBackupStorage implements BackupStorage {
  private baseDir: string;

  constructor(baseDir: string = './backups') {
    this.baseDir = baseDir;
  }

  private getProjectDir(projectId: string): string {
    return path.join(this.baseDir, projectId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }

  async saveBackup(record: BackupRecord): Promise<void> {
    const projDir = this.getProjectDir(record.projectId);
    await fs.mkdir(projDir, { recursive: true });
    const filePath = path.join(projDir, `${record.id}.json`);
    const tempPath = `${filePath}.${Date.now()}.tmp`;
    const data = JSON.stringify({ ...record, storageType: 'local_external' as const }, null, 2);
    await fs.writeFile(tempPath, data, 'utf8');
    await fs.rename(tempPath, filePath);
  }

  async loadBackup(backupId: string, projectId: string): Promise<BackupRecord | null> {
    const projDir = this.getProjectDir(projectId);
    const filePath = path.join(projDir, `${backupId}.json`);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content) as BackupRecord;
      return { ...parsed, storageType: 'local_external' };
    } catch {
      return null;
    }
  }

  async listBackups(projectId: string): Promise<Array<Omit<BackupRecord, 'manifestJson'>>> {
    const projDir = this.getProjectDir(projectId);
    try {
      const files = await fs.readdir(projDir);
      const results: Array<Omit<BackupRecord, 'manifestJson'>> = [];
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
        const filePath = path.join(projDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const parsed = JSON.parse(content) as BackupRecord;
          results.push({
            id: parsed.id,
            projectId: parsed.projectId,
            version: parsed.version,
            checksumSha256: parsed.checksumSha256,
            createdAt: parsed.createdAt,
            storageType: 'local_external',
          });
        } catch {
          // Skip invalid backup files
        }
      }
      return results.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }
}

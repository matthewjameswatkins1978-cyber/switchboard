import type { DatabaseSession } from '../db/database.js';
import type { AuthPrincipal, EndpointRole } from '../core/types.js';
import { SwitchboardError } from '../core/errors.js';

export async function sha256(text: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AuthService {
  private db: DatabaseSession;

  constructor(db: DatabaseSession) {
    this.db = db;
  }

  async authenticate(rawToken: string): Promise<AuthPrincipal> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new SwitchboardError('UNAUTHORIZED', 'Missing or invalid authorization token');
    }

    const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7).trim() : rawToken.trim();
    if (!token) {
      throw new SwitchboardError('UNAUTHORIZED', 'Bearer token is empty');
    }

    const tokenHash = await sha256(token);
    const row = await this.db.queryFirst<{
      endpoint_id: string;
      project_id: string;
      scopes: string;
      expires_at: number | null;
      revoked: number;
      role: EndpointRole;
    }>(
      `SELECT c.endpoint_id, c.project_id, c.scopes, c.expires_at, c.revoked, e.role
       FROM credentials c
       JOIN endpoints e ON c.endpoint_id = e.id AND c.project_id = e.project_id
       WHERE c.token_hash = ?`,
      [tokenHash]
    );

    if (!row) {
      throw new SwitchboardError('UNAUTHORIZED', 'Invalid credentials');
    }

    if (row.revoked === 1) {
      throw new SwitchboardError('UNAUTHORIZED', 'Credential has been revoked');
    }

    if (row.expires_at !== null && Date.now() > row.expires_at) {
      throw new SwitchboardError('UNAUTHORIZED', 'Credential has expired');
    }

    let scopes: string[] = [];
    try {
      scopes = JSON.parse(row.scopes);
    } catch {
      scopes = row.scopes.split(',').map((s) => s.trim()).filter(Boolean);
    }

    return {
      endpointId: row.endpoint_id,
      projectId: row.project_id,
      scopes,
      role: row.role ?? 'agent',
    };
  }

  async createProject(id: string, name: string): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
      [id, name, now]
    );
  }

  async registerEndpoint(
    projectId: string,
    endpointId: string,
    name: string,
    role: EndpointRole = 'agent'
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      // Ensure project exists
      await tx.execute(
        `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
        [projectId, projectId, now]
      );
      // Insert endpoint
      await tx.execute(
        `INSERT INTO endpoints (id, project_id, name, role, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role`,
        [endpointId, projectId, name, role, now]
      );
      // Initialize default status
      await tx.execute(
        `INSERT OR IGNORE INTO endpoint_status
         (endpoint_id, project_id, state, description, revision, last_heartbeat_at, updated_at, updated_by)
         VALUES (?, ?, 'available', 'Endpoint initialized', 1, ?, ?, ?)`,
        [endpointId, projectId, now, now, endpointId]
      );
    });
  }

  async issueToken(
    projectId: string,
    endpointId: string,
    rawToken: string,
    scopes: string[] = ['read', 'write'],
    expiresInMs?: number
  ): Promise<void> {
    const tokenHash = await sha256(rawToken);
    const now = Date.now();
    const expiresAt = expiresInMs ? now + expiresInMs : null;

    await this.db.execute(
      `INSERT INTO credentials (token_hash, endpoint_id, project_id, scopes, expires_at, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(token_hash) DO UPDATE SET
         scopes = excluded.scopes,
         expires_at = excluded.expires_at,
         revoked = 0`,
      [tokenHash, endpointId, projectId, JSON.stringify(scopes), expiresAt, now]
    );
  }

  async revokeToken(rawToken: string): Promise<void> {
    const tokenHash = await sha256(rawToken);
    await this.db.execute(`UPDATE credentials SET revoked = 1 WHERE token_hash = ?`, [tokenHash]);
  }
}

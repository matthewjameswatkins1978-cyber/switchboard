import type { DatabaseSession } from './database.js';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  token_hash TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS messages (
  internal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES endpoints(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('endpoint', 'channel')),
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
  thread_id TEXT,
  reply_to_id TEXT,
  evidence_refs TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, sender_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(project_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(project_id, reply_to_id);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES endpoints(id),
  recipient_id TEXT NOT NULL REFERENCES endpoints(id),
  channel_id TEXT REFERENCES channels(id),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STORED', 'RECEIVED', 'ACKNOWLEDGED')),
  delivered_at INTEGER NOT NULL,
  received_at INTEGER,
  acknowledged_at INTEGER,
  acknowledgement_note TEXT,
  UNIQUE (project_id, recipient_id, sequence),
  UNIQUE (project_id, sender_id, message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status ON message_deliveries(project_id, recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_seq ON message_deliveries(project_id, recipient_id, sequence);

CREATE TABLE IF NOT EXISTS endpoint_status (
  endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('available', 'busy', 'waiting', 'stale', 'offline')),
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  last_heartbeat_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);
`;

export async function initializeSchema(db: DatabaseSession): Promise<void> {
  await db.exec(SCHEMA_SQL);
}

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
  envelope_hash TEXT NOT NULL,
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
  status TEXT NOT NULL CHECK (status IN ('STORED', 'RECEIVED', 'ACKNOWLEDGED', 'DEAD_LETTER')),
  delivered_at INTEGER NOT NULL,
  received_at INTEGER,
  acknowledged_at INTEGER,
  acknowledgement_note TEXT,
  dead_letter_reason TEXT,
  dead_letter_at INTEGER,
  UNIQUE (project_id, recipient_id, sequence),
  UNIQUE (project_id, sender_id, message_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_status ON message_deliveries(project_id, recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_recipient_seq ON message_deliveries(project_id, recipient_id, sequence);

CREATE TABLE IF NOT EXISTS endpoint_status (
  endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('available', 'busy', 'waiting', 'stale', 'offline', 'retired')),
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

CREATE TABLE IF NOT EXISTS archived_messages (
  id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  priority TEXT NOT NULL,
  thread_id TEXT,
  reply_to_id TEXT,
  evidence_refs TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, sender_id, id)
);

CREATE TABLE IF NOT EXISTS archived_deliveries (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  channel_id TEXT,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  received_at INTEGER,
  acknowledged_at INTEGER,
  acknowledgement_note TEXT,
  dead_letter_reason TEXT,
  dead_letter_at INTEGER,
  archived_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_deliveries_recipient_seq ON archived_deliveries(project_id, recipient_id, sequence);

CREATE TABLE IF NOT EXISTS endpoint_sequences (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, recipient_id)
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_accounting (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cycle_start_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  max_requests INTEGER NOT NULL DEFAULT 3000000,
  max_rows_written INTEGER NOT NULL DEFAULT 3000000,
  max_storage_bytes INTEGER NOT NULL DEFAULT 500000000,
  updated_at INTEGER NOT NULL
);

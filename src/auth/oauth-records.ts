import type { DurableObjectStorage, KVNamespace } from '@cloudflare/workers-types';

type RecordRow = {
  name: string;
  value: string | null;
  expiration: number | null;
  metadata: string | null;
};

type ReadOptions = 'text' | 'json' | { type?: 'text' | 'json' };
type PutOptions = { expiration?: number; expirationTtl?: number; metadata?: unknown };
type ListOptions = { prefix?: string; cursor?: string; limit?: number };
const DAY = 86_400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// The previous version remains an immutable migration source after 100% cutover.
// This lifetime exceeds all registration records issued by that version.
const legacyLifetime = 91 * DAY;
const legacyDisabledAt = 'legacy_disabled_at';

export class OAuthRecords {
  private readonly changes = new Map<string, RecordRow>();

  static initialize(storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_record (name TEXT PRIMARY KEY, value TEXT, expiration INTEGER, metadata TEXT)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS oauth_expiration ON oauth_record (expiration)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS oauth_config (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    storage.sql.exec('INSERT OR IGNORE INTO oauth_config VALUES (?, ?)', legacyDisabledAt, nowSeconds() + legacyLifetime);
  }

  constructor(private readonly storage: DurableObjectStorage, private readonly legacy: KVNamespace) {}

  private get legacyDeadline() {
    return this.storage.sql.exec<{ value: number }>('SELECT value FROM oauth_config WHERE name = ?', legacyDisabledAt).one().value;
  }

  private row(name: string) {
    return this.changes.get(name) ?? this.storage.sql.exec<RecordRow>(
      'SELECT name, value, expiration, metadata FROM oauth_record WHERE name = ?', name,
    ).toArray()[0];
  }

  async get(name: string, options?: ReadOptions): Promise<unknown> {
    // A revoked grant must fence every legacy access token, even if an old KV
    // listing omitted that token during revocation.
    if (name.startsWith('token:')) {
      const [, user, grant] = name.split(':');
      if (await this.get('grant:' + user + ':' + grant) === null) return null;
    }
    const row = this.row(name);
    const value = row
      ? (row.expiration !== null && row.expiration <= nowSeconds() ? null : row.value)
      : (nowSeconds() < this.legacyDeadline && !name.startsWith('retry:') ? await this.legacy.get(name) : null);
    const type = typeof options === 'string' ? options : options?.type;
    return value !== null && type === 'json' ? JSON.parse(value) : value;
  }

  async put(name: string, value: string, options?: PutOptions) {
    this.changes.set(name, {
      name, value, expiration: options?.expiration ??
        (options?.expirationTtl === undefined ? null : nowSeconds() + options.expirationTtl),
      metadata: options?.metadata === undefined ? null : JSON.stringify(options.metadata),
    });
  }

  async delete(name: string) {
    this.changes.set(name, { name, value: null, expiration: this.legacyDeadline, metadata: null });
  }

  async list({ prefix = '', cursor, limit = 1000 }: ListOptions = {}) {
    type Key = { name: string; expiration?: number; metadata?: unknown };
    const keys = new Map<string, Key>();
    if (nowSeconds() < this.legacyDeadline) {
      let next: string | undefined;
      do {
        const page = await this.legacy.list({ prefix, cursor: next });
        for (const key of page.keys) keys.set(key.name, key);
        next = page.list_complete ? undefined : page.cursor;
      } while (next);
    }
    const rows = this.storage.sql.exec<RecordRow>(
      'SELECT name, value, expiration, metadata FROM oauth_record WHERE name >= ? AND name < ?',
      prefix, prefix + '\uffff',
    );
    const apply = (row: RecordRow) => {
      keys.delete(row.name);
      if (row.value !== null && (row.expiration === null || row.expiration > nowSeconds())) {
        keys.set(row.name, { name: row.name, expiration: row.expiration ?? undefined,
          metadata: row.metadata === null ? undefined : JSON.parse(row.metadata) });
      }
    };
    for (const row of rows) apply(row);
    for (const row of this.changes.values()) {
      if (row.name.startsWith(prefix)) apply(row);
    }
    const names = [...keys.keys()].filter(name => !cursor || name > cursor).sort();
    const result = names.slice(0, limit);
    return { keys: result.map(name => keys.get(name)!), list_complete: names.length <= limit,
      cursor: names.length > limit ? result.at(-1) : undefined };
  }

  commit() {
    if (!this.changes.size) return;
    const deadline = this.legacyDeadline;
    this.storage.transactionSync(() => {
      for (const row of this.changes.values()) {
        this.storage.sql.exec('INSERT OR REPLACE INTO oauth_record VALUES (?, ?, ?, ?)',
          row.name, row.value, row.expiration, row.metadata);
      }
      this.storage.sql.exec("DELETE FROM oauth_record WHERE expiration <= ? AND (name LIKE 'retry:%' OR ? >= ?)",
        nowSeconds(), nowSeconds(), deadline);
    });
  }
}

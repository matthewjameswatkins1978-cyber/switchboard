import type { DatabaseSession } from '../db/database.js';

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HEADER = 'X-Switchboard-Protocol';
export const PROTOCOL_INFO = {
  current: PROTOCOL_VERSION,
  supported: [PROTOCOL_VERSION],
  default: PROTOCOL_VERSION,
  header: PROTOCOL_HEADER,
} as const;

/** Absent header preserves compatibility with existing v1 clients. */
export function acceptsProtocol(header: string | undefined): boolean {
  return header === undefined || header === String(PROTOCOL_VERSION);
}

export function isPausedSetting(value: string | undefined): boolean {
  return value === '1';
}

/** A bounded read-only probe; no row content or exception detail leaves this boundary. */
export async function checkReadiness(db: Pick<DatabaseSession, 'query'>, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await db.query('SELECT 1 FROM messages LIMIT 1');
        await db.query('SELECT 1 FROM message_deliveries LIMIT 1');
        return true;
      })(),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

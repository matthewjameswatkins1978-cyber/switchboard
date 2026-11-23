import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PlugConfig {
  baseUrl: string;
  token?: string;
  endpointId: string;
  projectId: string;
  storagePath: string;
  timeoutMs: number;
  autoFlushUrgent: boolean;
}

export type ResolvedPlugConfig = PlugConfig & {
  hasToken: boolean;
  configPath: string;
};

const DEFAULT_STAGING_URL = 'https://switchboard-staging.matthewjameswatkins1978.workers.dev';
const DEFAULT_ENDPOINT_ID = 'antigravity';
const DEFAULT_PROJECT_ID = 'workshop';
const DEFAULT_TIMEOUT_MS = 15000;

export function getDefaultConfigDir(): string {
  return path.join(os.homedir(), '.switchboard');
}

export function getDefaultConfigPath(): string {
  return path.join(getDefaultConfigDir(), 'config.json');
}

export function getDefaultStoragePath(endpointId: string = DEFAULT_ENDPOINT_ID): string {
  return path.join(getDefaultConfigDir(), `state-${endpointId}.sqlite`);
}

export function loadPlugConfigFile(customPath?: string): Partial<PlugConfig> | null {
  const candidates = [
    customPath,
    process.env.SWITCHBOARD_CONFIG_PATH,
    getDefaultConfigPath(),
    path.resolve(process.cwd(), '.switchboard', 'config.json'),
    path.resolve(process.cwd(), '.switchboard.json'),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          baseUrl: parsed.baseUrl || parsed.url,
          token: parsed.token,
          endpointId: parsed.endpointId,
          projectId: parsed.projectId,
          storagePath: parsed.storagePath,
          timeoutMs: parsed.timeoutMs,
          autoFlushUrgent: parsed.autoFlushUrgent,
        };
      }
    } catch {
      // ignore invalid files and try next
    }
  }

  return null;
}

export function savePlugConfigFile(config: Partial<PlugConfig>, customPath?: string): string {
  const targetPath = customPath || process.env.SWITCHBOARD_CONFIG_PATH || getDefaultConfigPath();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(targetPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2), 'utf8');
  return targetPath;
}

export function resolvePlugConfig(overrides?: Partial<PlugConfig>): ResolvedPlugConfig {
  const fileConfig = loadPlugConfigFile() || {};

  const baseUrl = (
    overrides?.baseUrl ||
    process.env.SWITCHBOARD_URL ||
    fileConfig.baseUrl ||
    DEFAULT_STAGING_URL
  ).replace(/\/$/, '');

  const endpointId =
    overrides?.endpointId ||
    process.env.SWITCHBOARD_ENDPOINT_ID ||
    fileConfig.endpointId ||
    DEFAULT_ENDPOINT_ID;

  const projectId =
    overrides?.projectId ||
    process.env.SWITCHBOARD_PROJECT_ID ||
    fileConfig.projectId ||
    DEFAULT_PROJECT_ID;

  const token =
    overrides?.token ||
    process.env.SWITCHBOARD_TOKEN ||
    fileConfig.token ||
    '';

  const storagePath =
    overrides?.storagePath ||
    process.env.SWITCHBOARD_STORAGE_PATH ||
    fileConfig.storagePath ||
    getDefaultStoragePath(endpointId);

  const timeoutMs =
    overrides?.timeoutMs ||
    (process.env.SWITCHBOARD_TIMEOUT_MS ? Number(process.env.SWITCHBOARD_TIMEOUT_MS) : undefined) ||
    fileConfig.timeoutMs ||
    DEFAULT_TIMEOUT_MS;

  const autoFlushUrgent =
    overrides?.autoFlushUrgent ??
    fileConfig.autoFlushUrgent ??
    true;

  const configPath = process.env.SWITCHBOARD_CONFIG_PATH || getDefaultConfigPath();

  return {
    baseUrl,
    token: token || undefined,
    endpointId,
    projectId,
    storagePath,
    timeoutMs,
    autoFlushUrgent,
    hasToken: Boolean(token && token.trim().length > 0),
    configPath,
  };
}

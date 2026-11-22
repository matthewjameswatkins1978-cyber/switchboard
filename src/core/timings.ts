import type { EndpointState } from './types.js';

export interface TimingConfig {
  urgentSyncMs: number;
  normalLingerMs: number;
  activeInboxCadenceMs: number;
  awaitingResponseCadenceMs: number;
  quietCadenceMs: number;
  idleCadenceMs: number;
  heartbeatIntervalMs: number;
  stalePresenceThresholdMs: number;
  minRetryMs: number;
  maxRetryMs: number;
}

export const DEFAULT_TIMINGS: TimingConfig = {
  urgentSyncMs: 500, // Immediate/flush
  normalLingerMs: 3000, // 3s batch linger
  activeInboxCadenceMs: 30000, // 30s
  awaitingResponseCadenceMs: 10000, // 10s
  quietCadenceMs: 60000, // 60s
  idleCadenceMs: 180000, // 180s (120-300s)
  heartbeatIntervalMs: 60000, // 60s piggyback
  stalePresenceThresholdMs: 180000, // 3 missed heartbeats = 3 * 60s = 180s
  minRetryMs: 2000, // 2s
  maxRetryMs: 120000, // 120s
};

/**
 * Calculates recommended next sync interval based on endpoint state and recent activity
 */
export function calculateRecommendedNextSync(params: {
  endpointState?: EndpointState;
  hasUrgentActivity?: boolean;
  hasUnreadMessages?: boolean;
  isAwaitingResponse?: boolean;
  awaitingResponseStartMs?: number;
  now?: number;
  config?: TimingConfig;
}): number {
  const config = params.config ?? DEFAULT_TIMINGS;
  const now = params.now ?? Date.now();

  if (params.hasUrgentActivity) {
    return config.urgentSyncMs;
  }

  if (params.isAwaitingResponse || params.endpointState === 'waiting') {
    const elapsedAwaiting = params.awaitingResponseStartMs !== undefined
      ? now - params.awaitingResponseStartMs : Infinity;
    // SPEC: 10 seconds, limited to 2 minutes then normal
    if (elapsedAwaiting < 120000) {
      return config.awaitingResponseCadenceMs;
    }
  }

  if (params.hasUnreadMessages || params.endpointState === 'busy') {
    return config.activeInboxCadenceMs;
  }

  if (params.endpointState === 'waiting') {
    return config.activeInboxCadenceMs;
  }

  if (params.endpointState === 'available') {
    return config.activeInboxCadenceMs;
  }

  if (params.endpointState === 'stale' || params.endpointState === 'offline') {
    return config.idleCadenceMs;
  }

  return config.quietCadenceMs;
}

/**
 * Exponential backoff with full jitter:
 * sleep = uniform_random(0, min(maxRetry, minRetry * 2^attempt))
 */
export function calculateExponentialBackoffWithJitter(
  attempt: number,
  config: TimingConfig = DEFAULT_TIMINGS
): number {
  const cap = config.maxRetryMs;
  const base = config.minRetryMs;
  const exponential = Math.min(cap, base * Math.pow(2, attempt));
  // Full jitter: uniformly distributed between base / 2 and exponential
  const halfBase = Math.floor(base / 2);
  return halfBase + Math.floor(Math.random() * (exponential - halfBase + 1));
}

/**
 * Determines whether an endpoint presence is stale based on last heartbeat
 */
export function isPresenceStale(
  lastHeartbeatAt: number,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_TIMINGS.stalePresenceThresholdMs
): boolean {
  return now - lastHeartbeatAt > thresholdMs;
}

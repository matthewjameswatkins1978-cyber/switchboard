import { describe, it, expect } from 'vitest';
import {
  calculateRecommendedNextSync,
  calculateExponentialBackoffWithJitter,
  isPresenceStale,
  DEFAULT_TIMINGS,
} from '../../src/core/timings.js';

describe('Adaptive Communication Timings', () => {
  it('recommends immediate sync (500ms) on urgent activity', () => {
    const nextSync = calculateRecommendedNextSync({
      hasUrgentActivity: true,
      endpointState: 'available',
    });
    expect(nextSync).toBe(500);
  });

  it('recommends 10s cadence when explicitly awaiting response within 2 minutes', () => {
    const now = 1000000;
    const nextSync = calculateRecommendedNextSync({
      isAwaitingResponse: true,
      awaitingResponseStartMs: now - 30000, // 30s elapsed (< 120s)
      now,
    });
    expect(nextSync).toBe(10000);
  });

  it('falls back to normal cadence after awaiting response exceeds 2 minutes', () => {
    const now = 1000000;
    const nextSync = calculateRecommendedNextSync({
      isAwaitingResponse: true,
      awaitingResponseStartMs: now - 130000, // 130s elapsed (> 120s)
      endpointState: 'available',
      now,
    });
    expect(nextSync).toBe(DEFAULT_TIMINGS.activeInboxCadenceMs);
  });

  it('recommends 30s cadence for busy or active endpoints with unread messages', () => {
    const nextSync = calculateRecommendedNextSync({
      hasUnreadMessages: true,
      endpointState: 'busy',
    });
    expect(nextSync).toBe(30000);
  });

  it('bounds the waiting cadence at two minutes even if presence remains waiting', () => {
    const now = 1_000_000;
    expect(calculateRecommendedNextSync({ endpointState: 'waiting', awaitingResponseStartMs: now - 119_999, now })).toBe(10_000);
    expect(calculateRecommendedNextSync({ endpointState: 'waiting', awaitingResponseStartMs: now - 120_000, now })).toBe(30_000);
    expect(calculateRecommendedNextSync({ endpointState: 'waiting', now })).toBe(30_000);
  });

  it('recommends 180s idle cadence for stale or offline endpoints', () => {
    const nextSync = calculateRecommendedNextSync({
      endpointState: 'offline',
    });
    expect(nextSync).toBe(180000);
  });

  it('calculates exponential backoff with jitter bounded between min and max retry', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const backoff = calculateExponentialBackoffWithJitter(attempt);
      expect(backoff).toBeGreaterThanOrEqual(DEFAULT_TIMINGS.minRetryMs / 2);
      expect(backoff).toBeLessThanOrEqual(DEFAULT_TIMINGS.maxRetryMs);
    }
  });

  it('detects stale presence when heartbeats are missed past threshold', () => {
    const now = 1000000;
    const freshHb = now - 60000; // 60s ago (< 180s)
    expect(isPresenceStale(freshHb, now)).toBe(false);

    const staleHb = now - 181000; // 181s ago (> 180s)
    expect(isPresenceStale(staleHb, now)).toBe(true);
  });
});

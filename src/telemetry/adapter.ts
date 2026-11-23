export const SIGNALS = {
  'request.duration': { kind: 'measurement', unit: 'ms' },
  'request.completed': { kind: 'counter', unit: 'count' },
  'request.failed': { kind: 'counter', unit: 'count' },
  'request.inflight': { kind: 'gauge', unit: 'count' },
  'session.started': { kind: 'event', unit: 'count' },
  'session.stopped': { kind: 'event', unit: 'count' },
} as const;

export type SignalName = keyof typeof SIGNALS;
export type SignalKind = (typeof SIGNALS)[SignalName]['kind'];
export interface Observation {
  v: 1;
  seq: number;
  kind: SignalKind;
  name: SignalName;
  value: number;
  unit: 'ms' | 'count';
  observed_at: string;
}

/** Implementations must enqueue synchronously, without doing blocking IO. */
export interface ObservationTransport {
  offer(observation: Observation): void;
  close(): Promise<void>;
}

/** Only fixed, numeric signals can cross this boundary. No arbitrary metadata. */
export class Telemetry {
  private seq = 0;
  private readonly transport: ObservationTransport;

  constructor(transport: ObservationTransport) { this.transport = transport; }

  emit(name: SignalName, value = 1): void {
    try {
      if (!Object.hasOwn(SIGNALS, name) || !Number.isFinite(value) || value < 0) return;
      const signal = SIGNALS[name];
      if (signal.kind !== 'measurement' && !Number.isSafeInteger(value)) return;
      if (signal.kind === 'event' && value !== 1) return;
      this.transport.offer({
        v: 1, seq: ++this.seq, kind: signal.kind, name, value,
        unit: signal.unit, observed_at: new Date().toISOString(),
      });
    } catch {
      // Optional observations must never change application outcomes.
    }
  }

  async close(): Promise<void> {
    try { await this.transport.close(); } catch { /* best effort */ }
  }
}

/** Observe only timing, response category and in-flight count, never request data. */
export function observeFetch<Args extends unknown[]>(
  telemetry: Telemetry,
  fetch: (...args: Args) => Response | Promise<Response>,
): (...args: Args) => Promise<Response> {
  let inflight = 0;
  return async (...args) => {
    const started = performance.now();
    telemetry.emit('request.inflight', ++inflight);
    try {
      const response = await fetch(...args);
      if (response.status >= 400) telemetry.emit('request.failed');
      return response;
    } catch (error) {
      telemetry.emit('request.failed');
      throw error;
    } finally {
      telemetry.emit('request.duration', Math.max(0, performance.now() - started));
      telemetry.emit('request.completed');
      telemetry.emit('request.inflight', --inflight);
    }
  };
}

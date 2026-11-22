export interface OperationMetric {
  operation: string;
  outcome: 'success' | 'error' | 'conflict' | 'rate_limited';
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
  rowsRead?: number;
  rowsWritten?: number;
}

export class MetricsCollector {
  private static instance: MetricsCollector;

  private operations: Map<string, number> = new Map();
  private outcomes: Map<string, number> = new Map();
  private totalRequestBytes = 0;
  private totalResponseBytes = 0;
  private totalRowsRead = 0;
  private totalRowsWritten = 0;

  private acceptedMessages = 0;
  private acknowledgedDeliveries = 0;
  private duplicateSuppressed = 0;

  // Latency buckets: <= 5, 25, 50, 100, 250, 500, 1000, 2000, >2000 ms
  private latencyBuckets: Record<string, number> = {
    'le_5': 0,
    'le_25': 0,
    'le_50': 0,
    'le_100': 0,
    'le_250': 0,
    'le_500': 0,
    'le_1000': 0,
    'le_2000': 0,
    'inf': 0,
  };
  private totalDurationMs = 0;
  private totalCalls = 0;

  constructor() {}

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  recordOperation(metric: OperationMetric): void {
    this.totalCalls++;
    this.totalDurationMs += metric.durationMs;

    const opKey = metric.operation;
    this.operations.set(opKey, (this.operations.get(opKey) ?? 0) + 1);

    const outcomeKey = `${metric.operation}:${metric.outcome}`;
    this.outcomes.set(outcomeKey, (this.outcomes.get(outcomeKey) ?? 0) + 1);

    if (metric.requestBytes) this.totalRequestBytes += metric.requestBytes;
    if (metric.responseBytes) this.totalResponseBytes += metric.responseBytes;
    if (metric.rowsRead) this.totalRowsRead += metric.rowsRead;
    if (metric.rowsWritten) this.totalRowsWritten += metric.rowsWritten;

    const d = metric.durationMs;
    if (d <= 5) this.latencyBuckets['le_5']!++;
    else if (d <= 25) this.latencyBuckets['le_25']!++;
    else if (d <= 50) this.latencyBuckets['le_50']!++;
    else if (d <= 100) this.latencyBuckets['le_100']!++;
    else if (d <= 250) this.latencyBuckets['le_250']!++;
    else if (d <= 500) this.latencyBuckets['le_500']!++;
    else if (d <= 1000) this.latencyBuckets['le_1000']!++;
    else if (d <= 2000) this.latencyBuckets['le_2000']!++;
    else this.latencyBuckets['inf']!++;
  }

  recordMessageAccepted(count = 1): void {
    this.acceptedMessages += count;
  }

  recordDeliveryAcknowledged(count = 1): void {
    this.acknowledgedDeliveries += count;
  }

  recordDuplicateSuppressed(count = 1): void {
    this.duplicateSuppressed += count;
  }

  getSnapshot() {
    const avgLatency = this.totalCalls > 0 ? this.totalDurationMs / this.totalCalls : 0;
    return {
      timestamp: Date.now(),
      totalCalls: this.totalCalls,
      avgLatencyMs: Math.round(avgLatency * 100) / 100,
      totalRequestBytes: this.totalRequestBytes,
      totalResponseBytes: this.totalResponseBytes,
      totalRowsRead: this.totalRowsRead,
      totalRowsWritten: this.totalRowsWritten,
      acceptedMessages: this.acceptedMessages,
      acknowledgedDeliveries: this.acknowledgedDeliveries,
      duplicateSuppressed: this.duplicateSuppressed,
      operations: Object.fromEntries(this.operations),
      outcomes: Object.fromEntries(this.outcomes),
      latencyHistogram: { ...this.latencyBuckets },
    };
  }

  reset(): void {
    this.operations.clear();
    this.outcomes.clear();
    this.totalRequestBytes = 0;
    this.totalResponseBytes = 0;
    this.totalRowsRead = 0;
    this.totalRowsWritten = 0;
    this.acceptedMessages = 0;
    this.acknowledgedDeliveries = 0;
    this.duplicateSuppressed = 0;
    this.totalCalls = 0;
    this.totalDurationMs = 0;
    for (const k of Object.keys(this.latencyBuckets)) {
      this.latencyBuckets[k] = 0;
    }
  }
}

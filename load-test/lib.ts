/** Small, dependency-free helpers for the load test. */

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles over raw samples (no histogram approximation). */
export function latencyStats(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / sorted.length,
  };
}

export const round = (n: number, digits = 1): number => Number(n.toFixed(digits));

/** Parses Prometheus text format into "name{labels}" -> value, dropping the `instance` label. */
export function parsePrometheus(text: string): {
  instance: string | undefined;
  series: Map<string, number>;
} {
  const series = new Map<string, number>();
  let instance: string | undefined;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (!match) continue;
    const [, name = '', rawLabels = '', value = '0'] = match;
    const labels = [...rawLabels.matchAll(/(\w+)="([^"]*)"/g)]
      .filter(([, key, val]) => {
        if (key === 'instance') {
          instance = val;
          return false;
        }
        return true;
      })
      .map(([, key, val]) => `${key ?? ''}="${val ?? ''}"`)
      .join(',');
    series.set(labels ? `${name}{${labels}}` : name, Number(value));
  }
  return { instance, series };
}

/** Sum of every series of a metric whose labels contain all the given fragments. */
export function sumSeries(
  series: Map<string, number>,
  metric: string,
  ...fragments: string[]
): number {
  let total = 0;
  for (const [key, value] of series) {
    if (key !== metric && !key.startsWith(`${metric}{`)) continue;
    if (fragments.every((f) => key.includes(f)) && Number.isFinite(value)) total += value;
  }
  return total;
}

export function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

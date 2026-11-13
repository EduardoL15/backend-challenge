import { describe, expect, it } from 'bun:test';
import { latencyStats, parsePrometheus, sumSeries } from '../../../load-test/lib';

describe('latencyStats (nearest-rank)', () => {
  it('computes exact percentiles on 1..100', () => {
    const s = latencyStats(Array.from({ length: 100 }, (_, i) => i + 1).reverse());
    expect(s).toMatchObject({ count: 100, p50: 50, p95: 95, p99: 99, max: 100, mean: 50.5 });
  });

  it('handles tiny and empty samples', () => {
    expect(latencyStats([7])).toMatchObject({ p50: 7, p95: 7, p99: 7, max: 7 });
    expect(latencyStats([])).toMatchObject({ count: 0, p99: 0 });
  });
});

describe('parsePrometheus', () => {
  const text = [
    '# HELP x help',
    '# TYPE x counter',
    'wagering_lock_conflicts_total{kind="lock_timeout",instance="node-1"} 3',
    'wagering_lock_conflicts_total{kind="deadlock",instance="node-1"} 1',
    'wagering_outbox_published_total{instance="node-1"} 42',
    'wagering_broken NaN',
  ].join('\n');

  it('extracts the instance and strips it from the series keys', () => {
    const { instance, series } = parsePrometheus(text);
    expect(instance).toBe('node-1');
    expect(series.get('wagering_lock_conflicts_total{kind="lock_timeout"}')).toBe(3);
    expect(series.get('wagering_outbox_published_total')).toBe(42);
  });

  it('sums series by metric and label fragments, ignoring NaN', () => {
    const { series } = parsePrometheus(text);
    expect(sumSeries(series, 'wagering_lock_conflicts_total')).toBe(4);
    expect(sumSeries(series, 'wagering_lock_conflicts_total', 'kind="deadlock"')).toBe(1);
    expect(sumSeries(series, 'wagering_broken')).toBe(0);
    expect(sumSeries(series, 'wagering_lock')).toBe(0); // prefix of another metric name
  });
});

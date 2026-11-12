import { describe, expect, it } from 'bun:test';
import { PollingLoop } from '../../../src/infrastructure/workers/polling-loop';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PollingLoop', () => {
  it('stop() interrupts the idle sleep immediately', async () => {
    let iterations = 0;
    const loop = new PollingLoop({
      name: 'test',
      idleIntervalMs: 60_000,
      iterate: () => {
        iterations++;
        return Promise.resolve(false);
      },
    });
    loop.start();
    await sleep(20);
    const started = performance.now();
    await loop.stop(5_000);
    expect(performance.now() - started).toBeLessThan(500);
    expect(iterations).toBe(1);
  });

  it('keeps iterating without pause while there is a full batch of work', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 'test',
      idleIntervalMs: 60_000,
      iterate: () => Promise.resolve(++calls < 5),
    });
    loop.start();
    await sleep(50);
    await loop.stop(1_000);
    expect(calls).toBe(5);
  });

  it('survives a failing iteration and keeps going', async () => {
    let calls = 0;
    const loop = new PollingLoop({
      name: 'test',
      idleIntervalMs: 5,
      iterate: () => {
        calls++;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(false);
      },
    });
    loop.start();
    await sleep(100);
    await loop.stop(1_000);
    expect(calls).toBeGreaterThan(1);
  });

  it('waits for the running iteration before returning from stop()', async () => {
    let finished = false;
    const loop = new PollingLoop({
      name: 'test',
      idleIntervalMs: 60_000,
      iterate: async () => {
        await sleep(100);
        finished = true;
        return false;
      },
    });
    loop.start();
    await sleep(10);
    await loop.stop(5_000);
    expect(finished).toBe(true);
  });
});

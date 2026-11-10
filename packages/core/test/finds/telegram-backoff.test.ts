import { describe, expect, it } from 'vitest';
import { withBackoff } from '../../src/finds/telegram';

describe('withBackoff', () => {
  it('skips polls while backing off, doubling up to 5 minutes, and logs only the first failure and the recovery', async () => {
    let t = 0;
    let fail = true;
    let calls = 0;
    const logs: string[] = [];
    const poll = withBackoff(async () => { calls++; if (fail) throw new Error('getUpdates: telegram: timed out'); }, { log: (m) => logs.push(m), now: () => t });

    await poll(); // fails at t=0, next try at 10s
    expect(calls).toBe(1);
    t = 5_000; await poll();
    expect(calls).toBe(1); // still backing off
    t = 10_000; await poll(); // fails, next at 10s + 20s
    expect(calls).toBe(2);
    t = 29_000; await poll();
    expect(calls).toBe(2);
    t = 30_000; await poll();
    expect(calls).toBe(3);
    for (let i = 0; i < 10; i++) { t += 10 * 60_000; await poll(); }
    expect(calls).toBe(13);
    // The delay never exceeds 5 minutes.
    t += 5 * 60_000; await poll();
    expect(calls).toBe(14);
    expect(logs).toEqual(['telegram poll failed: getUpdates: telegram: timed out (retrying with a growing delay; repeats are not logged)']);

    fail = false;
    t += 5 * 60_000; await poll();
    expect(logs[1]).toBe('telegram: reachable again after 14 failed polls');
    t += 1; await poll();
    expect(calls).toBe(16); // no delay after a success
    expect(logs).toHaveLength(2);
  });
});

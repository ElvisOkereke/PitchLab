import { describe, expect, it } from 'vitest';
import { createSemaphore } from '@/lib/auth/semaphore';

describe('createSemaphore', () => {
  it('admits max holders, queues up to maxWaiting and refuses the rest', async () => {
    const s = createSemaphore(2, 3);
    const order: number[] = [];
    const a = await s.acquire()!;
    const b = await s.acquire()!;
    const waiting = [1, 2, 3].map((i) => s.acquire()!.then((release) => { order.push(i); return release; }));
    expect(s.acquire()).toBeNull();
    expect(s.stats()).toEqual({ active: 2, waiting: 3 });

    a();
    a(); // releasing twice frees only one slot
    const r1 = await waiting[0]!;
    expect(order).toEqual([1]);
    expect(s.stats()).toEqual({ active: 2, waiting: 2 });

    b();
    r1();
    const [r2, r3] = await Promise.all([waiting[1]!, waiting[2]!]);
    expect(order).toEqual([1, 2, 3]);
    r2();
    r3();
    expect(s.stats()).toEqual({ active: 0, waiting: 0 });
  });
});

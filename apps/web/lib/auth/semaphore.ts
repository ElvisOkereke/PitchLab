export type Semaphore = {
  /** A promise of a release function, or null when `maxWaiting` callers already wait (refuse instead of queueing). */
  acquire(): Promise<() => void> | null;
  stats(): { active: number; waiting: number };
};

/** At most `max` holders at once and at most `maxWaiting` queued callers (in-process). */
export function createSemaphore(max: number, maxWaiting: number): Semaphore {
  let active = 0;
  const queue: (() => void)[] = [];

  function makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else active -= 1;
    };
  }

  return {
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      if (queue.length >= maxWaiting) return null;
      return new Promise((resolve) => queue.push(() => resolve(makeRelease())));
    },
    stats: () => ({ active, waiting: queue.length }),
  };
}

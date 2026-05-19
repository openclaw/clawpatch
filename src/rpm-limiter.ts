export type RpmLimiter = {
  acquire(): Promise<void>;
};

type Clock = {
  now(): number;
  setTimeout(handler: () => void, ms: number): void;
};

const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    setTimeout(handler, ms).unref?.();
  },
};

const noopLimiter: RpmLimiter = {
  acquire: async () => {},
};

export function createRpmLimiter(
  limit: number | undefined,
  clock: Clock = defaultClock,
): RpmLimiter {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return noopLimiter;
  }
  const max = Math.floor(limit);
  const window = 60_000;
  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();

  function pruneOlder(reference: number): void {
    while (starts.length > 0) {
      const head = starts[0];
      if (head === undefined || reference - head < window) {
        return;
      }
      starts.shift();
    }
  }

  async function step(): Promise<void> {
    const now = clock.now();
    pruneOlder(now);
    if (starts.length < max) {
      starts.push(now);
      return;
    }
    const oldest = starts[0] ?? now;
    const wait = window - (now - oldest);
    await new Promise<void>((resolveWait) => {
      clock.setTimeout(resolveWait, Math.max(wait, 0));
    });
    const after = clock.now();
    pruneOlder(after);
    starts.push(after);
  }

  return {
    acquire(): Promise<void> {
      const next = chain.then(step);
      // Ensure rejections do not poison the chain for subsequent acquirers.
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

export function rpmFromFlag(
  explicit: string | undefined,
  envValue: string | undefined,
): number | undefined {
  const raw = explicit ?? envValue;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return Math.floor(parsed);
}

export function defaultJobs(coreCount: number): number {
  if (!Number.isFinite(coreCount) || coreCount < 1) {
    return 1;
  }
  return Math.min(Math.max(Math.floor(coreCount / 2), 1), 10);
}

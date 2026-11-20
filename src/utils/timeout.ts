/**
 * Give up waiting for a slow promise.
 *
 * Used for relayer SDK calls, which take no AbortSignal. The underlying request keeps
 * running in the background, but the user gets a clear error instead of a frozen screen.
 */

/** Error thrown by `withTimeout`; `code` matches ethers so the RPC error mapping applies. */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${Math.round(ms / 1000)} seconds`);
    this.name = 'TimeoutError';
  }
}

/** Resolve or reject like `promise`, or reject with `TimeoutError` after `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    // Never keep the process alive just to report a timeout.
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from '../../src/utils/timeout.js';

describe('withTimeout', () => {
  it('passes through a result that arrives in time', async () => {
    expect(await withTimeout(Promise.resolve(7), 1_000, 'x')).toBe(7);
  });

  it('passes through a rejection that arrives in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('nope')), 1_000, 'x')).rejects.toThrow(
      'nope',
    );
  });

  it('rejects with a TIMEOUT error when the promise hangs', async () => {
    const err = await withTimeout(new Promise(() => {}), 10, 'Decrypting').catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toMatch(/Decrypting/);
  });
});

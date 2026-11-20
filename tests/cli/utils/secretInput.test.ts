import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import { resolveSecretOption } from '../../../src/cli/utils/secretInput.js';

function io(isTTY: boolean, piped = '') {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = isTTY;
  stdin.end(piped);
  return { stdin, ask: vi.fn(async () => ' typed-key ') };
}

describe('resolveSecretOption', () => {
  it('uses a value given on the command line as-is (trimmed)', async () => {
    const i = io(true);
    expect(await resolveSecretOption(' abc ', 'Key', i)).toBe('abc');
    expect(i.ask).not.toHaveBeenCalled();
  });

  it('asks with hidden input when the flag has no value, or "-" on a terminal', async () => {
    for (const value of [true, '-'] as const) {
      const i = io(true);
      expect(await resolveSecretOption(value, 'Key', i)).toBe('typed-key');
      expect(i.ask).toHaveBeenCalledWith('Key');
    }
  });

  it('reads "-" from piped stdin', async () => {
    const i = io(false, 'piped-key\n');
    expect(await resolveSecretOption('-', 'Key', i)).toBe('piped-key');
    expect(i.ask).not.toHaveBeenCalled();
  });
});

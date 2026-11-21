import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import { maskUrlWhenAnswered, resolveSecretOption } from '../../../src/cli/utils/secretInput.js';

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

  it('refuses a second piped value instead of silently reading nothing', async () => {
    const i = io(false, 'first\n');
    expect(await resolveSecretOption('-', 'A', i)).toBe('first');
    await expect(resolveSecretOption('-', 'B', i)).rejects.toThrow(/Only one value can be piped/);
  });
});

describe('maskUrlWhenAnswered', () => {
  it('shows the typed URL while typing and only scheme and host once answered', () => {
    const url = 'https://rpc.example/v2/TYPEDKEY123';
    expect(maskUrlWhenAnswered(url, {}, { isFinal: false })).toBe(url);
    expect(maskUrlWhenAnswered(url, {}, { isFinal: true })).toBe('https://rpc.example/…');
  });
});

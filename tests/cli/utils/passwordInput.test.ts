import { PassThrough } from 'stream';
import { describe, expect, it } from 'vitest';
import { readPasswordFromStdin } from '../../../src/cli/utils/passwordInput.js';

function pipe(text: string, isTTY = false) {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = isTTY;
  s.end(text);
  return s;
}

describe('--password-stdin', () => {
  it('reads the piped password, dropping one line break but keeping spaces', async () => {
    expect(await readPasswordFromStdin(pipe('correct horse 1\n'))).toBe('correct horse 1');
    expect(await readPasswordFromStdin(pipe(' pad \r\n'))).toBe(' pad ');
    expect(await readPasswordFromStdin(pipe('two\n\n'))).toBe('two\n');
  });

  it('refuses a terminal and an empty pipe', async () => {
    await expect(readPasswordFromStdin(pipe('', true))).rejects.toThrow(
      /reads the password from a pipe/,
    );
    await expect(readPasswordFromStdin(pipe('\n'))).rejects.toThrow(/No password was piped/);
  });
});

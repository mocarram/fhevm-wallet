/**
 * Commands in scripts (no terminal): wallet create/import with --password-stdin, and
 * removals that say which option to add instead of failing with "Error:".
 */

import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI, tempHome } from './helpers.js';

const PHRASE = 'test test test test test test test test test test test junk';
const PHRASE_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

function run(home: string, args: string[], input = '') {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1' },
    input,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

describe('scripted wallet commands', () => {
  it('wallet create and import read the secrets from stdin', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const created = run(
      t.home,
      ['wallet', 'create', 'bot', '--password-stdin'],
      'long enough pw\n',
    );
    expect(created.code).toBe(0);
    expect(created.out).toMatch(/Wallet created/);
    // No terminal: the phrase is printed with a warning (the user asked for a script).
    expect(created.out).toMatch(/clear your scrollback/);

    const imported = run(
      t.home,
      ['wallet', 'import', 'hard', '--mnemonic', '--password-stdin'],
      `${PHRASE}\nlong enough pw\n`,
    );
    expect(imported.code).toBe(0);
    expect(imported.out).toContain(PHRASE_ADDRESS);

    const short = run(t.home, ['wallet', 'create', 'x', '--password-stdin'], 'short\n');
    expect(short.code).toBe(1);
    expect(short.out).toMatch(/at least 8 characters/);
    expect(short.out).not.toMatch(/Error:/);

    const noOption = run(t.home, ['wallet', 'create', 'y']);
    expect(noOption.code).toBe(1);
    expect(noOption.out).toMatch(/--password-stdin/);

    const noKind = run(t.home, ['wallet', 'import', 'z', '--password-stdin'], 'a\nb\n');
    expect(noKind.code).toBe(1);
    expect(noKind.out).toMatch(/--mnemonic or --key/);
  });

  it('removals without a terminal name --yes; tokens can be removed by symbol', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    run(t.home, ['wallet', 'create', 'bot', '--password-stdin'], 'long enough pw\n');
    const ask = run(t.home, ['wallet', 'remove', 'bot']);
    expect(ask.code).toBe(1);
    expect(ask.out).toMatch(/Add --yes/);
    expect(ask.out).not.toMatch(/Error:/);
    expect(run(t.home, ['wallet', 'remove', 'bot', '--yes']).code).toBe(0);

    const tok = run(t.home, ['token', 'remove', 'cusdc']);
    expect(tok.code).toBe(1);
    expect(tok.out).toMatch(/No tracked token called "cusdc"/);
  });
});

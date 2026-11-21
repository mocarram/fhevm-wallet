import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import { formatPhrase, showSecretScreen } from '../../../src/cli/utils/secretScreen.js';

function capture(isTTY: boolean) {
  const out = new PassThrough() as PassThrough & { isTTY?: boolean };
  out.isTTY = isTTY;
  let text = '';
  out.on('data', (c) => (text += c.toString()));
  return { out, text: () => text };
}

describe('showSecretScreen', () => {
  it('uses the alternate screen on a TTY and wipes it after Enter, not any key', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (b: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const { out, text } = capture(true);
    const done = showSecretScreen('Private key', ['0xSECRET'], {
      input,
      output: out,
      ignoreInputMs: 0,
    });
    let wiped = false;
    void done.then(() => (wiped = true));
    setTimeout(() => input.write('x'), 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(wiped).toBe(false); // a stray key does not wipe the phrase
    input.write('\r');
    expect(await done).toBe(true);
    const t = text();
    expect(t).toMatch(/Press Enter when you have it/);
    expect(t.startsWith('\x1b[?1049h')).toBe(true); // entered alternate screen first
    expect(t).toContain('0xSECRET');
    expect(t.endsWith('\x1b[2J\x1b[?1049l')).toBe(true); // cleared and left it last
    expect(input.setRawMode).toHaveBeenCalledWith(false);
  });

  it('prints with a warning when not attached to a terminal', async () => {
    const input = new PassThrough();
    const { out, text } = capture(false);
    expect(await showSecretScreen('Recovery phrase', ['a b c'], { input, output: out })).toBe(
      false,
    );
    expect(text()).toContain('a b c');
    expect(text()).toMatch(/clear your scrollback/);
    expect(text()).not.toContain('\x1b[?1049h');
  });
});

describe('formatPhrase', () => {
  it('numbers words four per line', () => {
    const lines = formatPhrase('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ 1 w1/);
    expect(lines[2]).toMatch(/12 w12/);
  });
});

describe('showSecretScreen input guard', () => {
  it('ignores a key that arrives right after the screen opens', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (b: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const { out, text } = capture(true);
    let wiped = false;
    const done = showSecretScreen('Recovery phrase', ['w1 w2'], {
      input,
      output: out,
      ignoreInputMs: 100,
    }).then(() => (wiped = true));
    input.write('\r'); // leftover Enter from the previous prompt
    await new Promise((r) => setTimeout(r, 30));
    expect(wiped).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    input.write('\r');
    await done;
    expect(text().endsWith('\x1b[2J\x1b[?1049l')).toBe(true);
  });
});

describe('showSecretScreen and signals', () => {
  it('restores the terminal before exiting on SIGTERM', async () => {
    const { EventEmitter } = await import('events');
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (b: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const { out, text } = capture(true);
    const fakeProc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    void showSecretScreen('Private key', ['0xSECRET'], {
      input,
      output: out,
      ignoreInputMs: 0,
      proc: fakeProc as never,
    });
    await new Promise((r) => setTimeout(r, 10));
    fakeProc.emit('SIGTERM', 'SIGTERM');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(text().endsWith('\x1b[2J\x1b[?1049l')).toBe(true);
    expect(fakeProc.exit).toHaveBeenCalledWith(143);
    input.write('\r'); // let the pending promise settle
  });

  it('removes its signal handlers once the screen is wiped', async () => {
    const { EventEmitter } = await import('events');
    const input = new PassThrough() as PassThrough & {
      isTTY?: boolean;
      setRawMode?: (b: boolean) => void;
    };
    input.isTTY = true;
    input.setRawMode = vi.fn();
    const { out } = capture(true);
    const fakeProc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const done = showSecretScreen('k', ['v'], {
      input,
      output: out,
      ignoreInputMs: 0,
      proc: fakeProc as never,
    });
    setTimeout(() => input.write('\r'), 10);
    await done;
    expect(fakeProc.listenerCount('SIGTERM')).toBe(0);
    expect(fakeProc.listenerCount('SIGINT')).toBe(0);
  });
});

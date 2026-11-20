import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runCli, tempHome } from './helpers.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('fhew binary', () => {
  it('prints the package version', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
    const res = runCli(['--version'], t.home);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });

  it('lists the send command in help', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const res = runCli(['--help'], t.home);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/send/);
  });

  it('fails cleanly (no stack trace) when sending with no wallet or token set up', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const res = runCli(
      ['send', '0x000000000000000000000000000000000000dEaD', '1', '-n', 'sepolia'],
      t.home,
    );
    expect(res.stdout + res.stderr).not.toMatch(/at .*\.js:\d+/);
  });
});

describe('fhew output hygiene', () => {
  it('prints nothing but the version (no library banners on stdout)', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const res = runCli(['--version'], t.home);
    expect(res.stdout.split('\n').filter(Boolean)).toHaveLength(1);
  });
});

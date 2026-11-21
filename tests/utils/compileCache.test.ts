import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileCacheDir, preparePrivateCacheDir } from '../../src/compileCache.js';

describe('compile cache folder', () => {
  it('lives under XDG_CACHE_HOME or ~/.cache, never in the wallet data folder', () => {
    expect(compileCacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe(
      '/x/cache/fhevm-wallet/compile-cache',
    );
    expect(compileCacheDir({ XDG_CACHE_HOME: 'relative' })).toMatch(
      /\.cache\/fhevm-wallet\/compile-cache$/,
    );
  });

  it('is created private and accepted', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-'));
    chmodSync(base, 0o700);
    const dir = join(base, 'fhevm-wallet', 'compile-cache');
    expect(preparePrivateCacheDir(dir)).toBe(true);
  });

  it('is refused when others could write to it or above it, or when it is a symlink', () => {
    const open = mkdtempSync(join(tmpdir(), 'cc-'));
    chmodSync(open, 0o777);
    expect(preparePrivateCacheDir(join(open, 'fhevm-wallet', 'compile-cache'))).toBe(false);

    const base = mkdtempSync(join(tmpdir(), 'cc-'));
    chmodSync(base, 0o700);
    mkdirSync(join(base, 'fhevm-wallet'), { mode: 0o700 });
    mkdirSync(join(base, 'fhevm-wallet', 'compile-cache'), { mode: 0o700 });
    chmodSync(join(base, 'fhevm-wallet', 'compile-cache'), 0o770);
    expect(preparePrivateCacheDir(join(base, 'fhevm-wallet', 'compile-cache'))).toBe(false);

    const linked = mkdtempSync(join(tmpdir(), 'cc-'));
    chmodSync(linked, 0o700);
    const target = mkdtempSync(join(tmpdir(), 'cc-target-'));
    mkdirSync(join(linked, 'fhevm-wallet'), { mode: 0o700 });
    symlinkSync(target, join(linked, 'fhevm-wallet', 'compile-cache'));
    expect(preparePrivateCacheDir(join(linked, 'fhevm-wallet', 'compile-cache'))).toBe(false);
  });
});

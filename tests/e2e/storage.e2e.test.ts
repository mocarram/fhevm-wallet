import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { CLI, runCli, tempHome } from './helpers.js';

let cleanup: () => void = () => {};
afterEach(() => cleanup());
const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(process.platform === 'win32')('wallet data storage', () => {
  it('uses FHEVM_WALLET_HOME and writes owner-only files', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'custom-data');
    const res = runCli(['config', '--etherscan-key', 'E2EKEY123'], t.home, {
      FHEVM_WALLET_HOME: dataDir,
    });
    expect(res.code).toBe(0);
    expect(existsSync(join(t.home, '.fhevm-wallet', '.env'))).toBe(false);
    expect(readFileSync(join(dataDir, '.env'), 'utf-8')).toBe('ETHERSCAN_API_KEY=E2EKEY123\n');
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, '.env'))).toBe(0o600);
  });

  it('tightens data written by older versions on startup and says so on stderr', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, '.fhevm-wallet');
    mkdirSync(join(dataDir, 'wallets'), { recursive: true });
    chmodSync(dataDir, 0o755);
    writeFileSync(join(dataDir, 'wallets', 'old.json'), '{}', { mode: 0o644 });
    const res = runCli(['--version'], t.home);
    expect(res.stderr).toMatch(/Restricted \d+ wallet data item\(s\)/);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mode(join(dataDir, 'wallets', 'old.json'))).toBe(0o600);
    expect(mode(dataDir)).toBe(0o700);
  });

  it('leaves files it did not create alone, keeping their exec bit', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'shared-data');
    mkdirSync(dataDir, { mode: 0o755 });
    writeFileSync(join(dataDir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dataDir, 'config.json'), '{}', { mode: 0o755 });
    const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: dataDir });
    expect(res.code).toBe(0);
    expect(mode(join(dataDir, 'run.sh'))).toBe(0o755);
    expect(mode(join(dataDir, 'config.json'))).toBe(0o700); // ours: group/other removed only
  });

  it('refuses to restrict a home folder used as FHEVM_WALLET_HOME', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    chmodSync(t.home, 0o755);
    const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: t.home });
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/which is your home folder/);
    expect(mode(t.home)).toBe(0o755);
  });

  it('never chmods a sticky shared folder, and refuses to trust a world-writable one', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const shared = join(t.home, 'tmp-like');
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: shared });
    expect(statSync(shared).mode & 0o7777).toBe(0o1777); // sticky bit and mode kept
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/a shared \(sticky\) folder/);
    expect(res.stderr).toMatch(/Other users can change the wallet data folder/);
    expect(res.stdout).toBe(''); // nothing ran
  });

  it('leaves the folder alone when it holds other files, and says so accurately', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'project');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    writeFileSync(join(dataDir, 'README.md'), 'x', { mode: 0o644 });
    const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: dataDir });
    expect(res.code).toBe(0);
    expect(mode(dataDir)).toBe(0o755);
    expect(mode(join(dataDir, 'README.md'))).toBe(0o644);
    expect(res.stderr).toMatch(/also holds files the wallet did not create/);
  });

  it('makes an existing empty folder named by FHEVM_WALLET_HOME private', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'fresh');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: dataDir });
    expect(res.code).toBe(0);
    expect(mode(dataDir)).toBe(0o700);
    expect(res.stderr).not.toMatch(/Warning/);
  });

  it('refuses to load keys from a data folder others can write to', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'planted');
    mkdirSync(join(dataDir, 'wallets'), { recursive: true });
    writeFileSync(join(dataDir, 'notes.txt'), 'not ours'); // so the folder is not chmodded
    chmodSync(dataDir, 0o777);
    const res = runCli(['wallet', 'list'], t.home, { FHEVM_WALLET_HOME: dataDir });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/will not load keys or settings from it/);
    expect(mode(dataDir)).toBe(0o777);
  });

  it('the default data folder is still tightened when it is the current folder', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, '.fhevm-wallet');
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const res = spawnSync(process.execPath, [CLI, '--version'], {
      env: { PATH: process.env.PATH ?? '', HOME: t.home, NO_COLOR: '1' },
      cwd: dataDir,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    expect(mode(dataDir)).toBe(0o700);
    expect(res.stderr).not.toMatch(/FHEVM_WALLET_HOME/);
  });

  it.skipIf(typeof process.getuid !== 'function' || process.getuid() !== 0)(
    'warns in one sentence when the data folder belongs to another user',
    () => {
      const t = tempHome();
      cleanup = t.cleanup;
      const dataDir = join(t.home, 'volume');
      mkdirSync(dataDir, { mode: 0o777 });
      chownSync(dataDir, 4242, 4242);
      const res = runCli(['--version'], t.home, { FHEVM_WALLET_HOME: dataDir });
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/belongs to another user/);
      expect(res.stderr).not.toMatch(/at .*\.js:\d+/); // no stack trace
    },
  );

  it('a data folder it may not create gets one sentence and exit 1, no stack', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const locked = join(t.home, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    chmodSync(locked, 0o500);
    // root ignores permission bits, so as root run the CLI as "nobody" in a folder only
    // root may enter.
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (asRoot) {
      chmodSync(t.home, 0o755);
      chmodSync(locked, 0o700);
    }
    const res = spawnSync(process.execPath, [CLI, '--version'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: t.home,
        NO_COLOR: '1',
        FHEVM_WALLET_HOME: join(locked, 'data'),
      },
      encoding: 'utf-8',
      timeout: 30_000,
      ...(asRoot ? { uid: 65534, gid: 65534 } : {}),
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^Cannot use the wallet data folder .*: permission denied\./);
    expect(res.stderr.trim().split('\n')).toHaveLength(1);
    expect(res.stderr).not.toMatch(/\n\s+at /);
  });

  it('an existing data folder it may not write to gets the same sentence', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const dataDir = join(t.home, 'readonly-data');
    mkdirSync(dataDir, { mode: 0o755 });
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (asRoot) chmodSync(t.home, 0o755);
    else chmodSync(dataDir, 0o500);
    const res = spawnSync(process.execPath, [CLI, '--version'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: t.home,
        NO_COLOR: '1',
        FHEVM_WALLET_HOME: dataDir,
      },
      encoding: 'utf-8',
      timeout: 30_000,
      // As root, run as "nobody": the folder is root's and 0755, so not writable for it.
      ...(asRoot ? { uid: 65534, gid: 65534 } : {}),
    });
    if (!asRoot) chmodSync(dataDir, 0o700);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^Cannot use the wallet data folder .*: permission denied\./);
    expect(res.stderr).not.toMatch(/EACCES/);
  });

  it('refuses a key that would inject another setting', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const res = runCli(['config', '--etherscan-key', 'A\nZAMA_MAINNET_API_KEY=x'], t.home);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/not allowed/);
  });
});

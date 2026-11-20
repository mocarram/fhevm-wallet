import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runCli, tempHome } from './helpers.js';

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
    expect(res.stderr).toMatch(/Secured permissions on \d+ wallet data file/);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mode(join(dataDir, 'wallets', 'old.json'))).toBe(0o600);
    expect(mode(dataDir)).toBe(0o700);
  });

  it('refuses a key that would inject another setting', () => {
    const t = tempHome();
    cleanup = t.cleanup;
    const res = runCli(['config', '--etherscan-key', 'A\nZAMA_MAINNET_API_KEY=x'], t.home);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/not allowed/);
  });
});

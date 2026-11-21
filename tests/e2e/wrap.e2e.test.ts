/**
 * End-to-end runs of wrap / unwrap (Phase 5) against the offline mock backend: the CLI
 * in scripts (--password-stdin, --yes, --json), an unwrap finished by a later process
 * (`--resume`), and the TUI in a pseudo-terminal. Nothing here talks to a real network.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { getAddress, id, Wallet } from 'ethers';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI } from './helpers.js';

const PASSWORD = 'wrap-e2e-pass';
const DRIVER = resolve(__dirname, 'pty_driver.py');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const work = mkdtempSync(join(tmpdir(), 'fhew-wrap-e2e-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Same derivation as MockBackend's mock addresses. */
const mockAddress = (label: string) => getAddress('0x' + id(`fhew-mock:${label}`).slice(-40));
const token = (symbol: string, name: string) => ({
  address: mockAddress(`sepolia:${symbol}`),
  name,
  symbol,
  decimals: 6,
  network: 'sepolia',
  addedAt: '2026-01-01T00:00:00.000Z',
});

/** A mock data folder with wallet "w" (cheap scrypt) tracking the given mock tokens. */
function mockHome(symbols: Array<[string, string]>): { home: string; data: string } {
  const home = mkdtempSync(join(work, 'home-'));
  const data = join(home, 'wallet-data');
  mkdirSync(join(data, 'wallets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(data, '.fhew-mock'), 'mock\n', { mode: 0o600 });
  const wallet = Wallet.createRandom();
  writeFileSync(
    join(data, 'wallets', 'w.json'),
    wallet.encryptSync(PASSWORD, { scrypt: { N: 1024 } } as never),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(data, 'wallets', 'w.meta.json'),
    JSON.stringify({ name: 'w', address: wallet.address, createdAt: '2026-01-01' }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(data, 'tokens.json'),
    JSON.stringify({ tokens: symbols.map(([s, n]) => token(s, n)) }),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(data, 'config.json'),
    JSON.stringify({ defaultNetwork: 'sepolia', defaultWallet: 'w' }),
    {
      mode: 0o600,
    },
  );
  return { home, data };
}

let h: { home: string; data: string };
beforeEach(() => {
  h = mockHome([
    ['cUSDC', 'Confidential USDC'],
    ['cDAI', 'Confidential DAI'],
  ]);
});

function cli(args: string[], env: Record<string, string> = {}, input = `${PASSWORD}\n`) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: h.home,
      FHEVM_WALLET_HOME: h.data,
      FHEW_BACKEND: 'mock',
      FHEW_MOCK_LATENCY_MS: '5',
      FHEW_MOCK_CONFIRM_MS: '5',
      NO_COLOR: '1',
      ...env,
    },
    input,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const json = (args: string[], env: Record<string, string> = {}) => {
  const r = cli([...args, '--json', '--yes', '--password-stdin'], env);
  try {
    return { ...r, doc: JSON.parse(r.stdout) };
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
};

describe('fhew wrap / unwrap (mock)', () => {
  it('refuses a wrap that mints 0 before asking for the password', () => {
    const r = cli(['wrap', '0.0000001', 'cdai', '--yes', '--password-stdin'], {}, '');
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/That wraps to 0 cDAI: the smallest amount is 0\.000001 DAI\./);
    expect(r.stdout).toMatch(/Nothing was signed/);
    expect(r.stderr).not.toMatch(/Wallet loaded/);
  });

  it('wraps max in ERC-20 units: exact approval, dust stays, balance up', () => {
    const r = cli(['wrap', 'max', 'dai', '--yes', '--password-stdin']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /You give:\s+1,000 DAI \(public; you have 1,000\.000000123456789 DAI\)/,
    );
    expect(r.stdout).toMatch(/Stays:\s+0\.000000123456789 DAI in your wallet/);
    expect(r.stdout).toMatch(/approve exactly 1,000 DAI for cDAI \(not unlimited\)/);
    expect(r.stdout).toMatch(/✔ Wrapped 1,000 DAI into 1,000 cDAI\./);
    expect(r.stdout).toMatch(/cDAI balance: 80\.5 cDAI → 1,080\.5 cDAI/);
    expect(r.stdout).toMatch(/MOCK/);
  });

  it('unwrap stops at pending, and a later process finishes it once', () => {
    const first = json(['unwrap', '10', 'cusdc'], { FHEW_MOCK_FAIL: 'public-pending' });
    expect(first.code).toBe(0);
    expect(first.doc).toMatchObject({ status: 'pending', state: 'requested', mock: true });
    const list = cli(['unwrap', '--list'], {}, '');
    expect(list.stdout).toMatch(/10 cUSDC → USDC\s+step 1 done, waiting to finish/);
    const resumed = json(['unwrap', '--resume']);
    expect(resumed.doc.results[0]).toMatchObject({ status: 'finished', state: 'finished' });
    const again = json(['unwrap', '--resume']);
    expect(again.doc.results).toEqual([]);
  });

  it('an unconfirmed request blocks a second one; --resume finishes it later', () => {
    const lost = json(['unwrap', '2', 'cusdc'], { FHEW_MOCK_FAIL: 'unconfirmed' });
    expect(lost.code).toBe(1);
    expect(lost.doc.error.code).toBe('SENT_UNCONFIRMED');
    const second = json(['unwrap', '2', 'cusdc']);
    expect(second.doc.error.code).toBe('UNWRAP_UNCONFIRMED');
    // The next process sees the request mined: it learns the id and sends step 2.
    const resumed = json(['unwrap', '--resume']);
    expect(resumed.doc.results[0]).toMatchObject({
      status: 'finished',
      requestTxHash: lost.doc.error.txHash,
    });
  });
});

type Step =
  | { keys: string }
  | { expect: string; timeout?: number }
  | { sleep: number }
  | { exit: number; timeout?: number };

function runTui(steps: Step[], env: Record<string, string> = {}): string[] {
  const script = join(work, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    script,
    JSON.stringify({
      argv: [process.execPath, CLI],
      cols: 100,
      rows: 34,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: h.home,
        FHEVM_WALLET_HOME: h.data,
        TERM: 'xterm-256color',
        FHEW_BACKEND: 'mock',
        FHEW_MOCK_LATENCY_MS: '20',
        FHEW_MOCK_CONFIRM_MS: '300',
        ...env,
      },
      steps,
    }),
  );
  const res = spawnSync(python!, ['-I', DRIVER, script], { encoding: 'utf-8', timeout: 120_000 });
  const out = JSON.parse(res.stdout) as {
    ok: boolean;
    error?: string;
    screen?: string;
    screens?: string[];
  };
  if (!out.ok) throw new Error(`${out.error}\n--- screen ---\n${out.screen}`);
  return out.screens ?? [];
}

describe.skipIf(!python)('wrap / unwrap in the TUI (pty, mock)', () => {
  it('Balances › w › amount › Review › unlock › Confirm, then :unwrap, both confirmed', () => {
    h = mockHome([['cUSDC', 'Confidential USDC']]);
    const screens = runTui([
      { expect: 'Balances', timeout: 20 },
      { keys: 'b' },
      { expect: 'wraps USDC · 500 USDC public', timeout: 20 },
      { keys: 'w' },
      { expect: 'Wrap USDC into cUSDC' },
      { keys: '25' },
      { expect: 'You get 25 cUSDC.' },
      { keys: '\r' },
      { expect: 'Wrap 25 USDC into 25 cUSDC' },
      { expect: 'Unlock and check' },
      { keys: '1' },
      { expect: 'Password for' },
      { keys: `${PASSWORD}\r` },
      { expect: 'Simulation passed', timeout: 30 },
      { expect: 'Approve cUSDC to take exactly 25 USDC (not unlimited)' },
      { keys: '1' },
      { expect: 'Wrapped 25 USDC → 25 cUSDC', timeout: 40 },
      { keys: ':' },
      { keys: 'unwrap 5 cusdc\r' },
      { expect: 'You get 5 USDC (public).', timeout: 20 },
      { keys: '\r' },
      { expect: 'Unwrap 5 cUSDC into 5 USDC' },
      { expect: 'Simulation passed', timeout: 30 },
      { keys: '1' },
      { expect: 'Unwrapped 5 cUSDC: 5 USDC arrived', timeout: 40 },
      { keys: '0' },
      { exit: 0, timeout: 15 },
    ]);
    expect(screens.join('\n')).toMatch(/MOCK · simulated, no real funds/);
  });

  it('a pending unwrap shows "Finish unwrap" on Home after a restart', () => {
    h = mockHome([['cUSDC', 'Confidential USDC']]);
    const first = json(['unwrap', '3', 'cusdc'], { FHEW_MOCK_FAIL: 'public-pending' });
    expect(first.doc.status).toBe('pending');
    runTui([
      { expect: 'Finish unwrap: 3 cUSDC → USDC', timeout: 20 },
      { expect: 'step 1 done, waiting to finish' },
      { keys: 'u' },
      { expect: 'Finish unwrap: 3 cUSDC → USDC' },
      { expect: 'Unlock and check', timeout: 20 },
      { keys: '1' },
      { expect: 'Password for' },
      { keys: `${PASSWORD}\r` },
      { expect: 'You get   3 USDC', timeout: 30 },
      { keys: '1' },
      { expect: 'Unwrapped 3 cUSDC: 3 USDC arrived', timeout: 40 },
      { keys: '0' },
      { exit: 0, timeout: 15 },
    ]);
    expect(json(['unwrap', '--resume']).doc.results).toEqual([]);
  });
});

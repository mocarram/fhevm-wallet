/**
 * End-to-end runs of the terminal UI: the built binary in a pseudo-terminal of a fixed
 * size (tests/e2e/pty_driver.py, Python standard library only), with the offline mock
 * backend and a throwaway data directory. Nothing here talks to a real network.
 */

import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { getAddress, id } from 'ethers';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI } from './helpers.js';

const DRIVER = resolve(__dirname, 'pty_driver.py');
const PASSWORD = 'correct horse 1';
const BOB = '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF';
const BOB_LOOKALIKE = '0x91bE9f71c0aE2B58d4a3f6C0B9e1D7a5f33207Af';
const ESC = '\u001b';
const CTRL_C = '\u0003';

type Step =
  | { keys: string; delay?: number }
  | { expect: string; timeout?: number }
  | { absent: string }
  | { sleep: number }
  | { exit: number; timeout?: number };

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const work = mkdtempSync(join(tmpdir(), 'fhew-tui-e2e-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A bare Esc needs a pause: readline waits 500 ms to tell it apart from an escape code. */
const esc = (): Step[] => [{ keys: ESC }, { sleep: 0.7 }];

/** Run the TUI in a pty against the mock backend; returns the screens seen. */
function runTui(
  home: string,
  steps: Step[],
  env: Record<string, string> = {},
  args: string[] = [],
): string[] {
  const script = join(work, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    script,
    JSON.stringify({
      argv: [process.execPath, CLI, ...args],
      cols: 100,
      rows: 34,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        // A separate folder: the mock refuses to run on the default ~/.fhevm-wallet.
        FHEVM_WALLET_HOME: join(home, 'wallet-data'),
        TERM: 'xterm-256color',
        FHEW_BACKEND: 'mock',
        FHEW_MOCK_LATENCY_MS: '20',
        FHEW_MOCK_CONFIRM_MS: '1200',
        ...env,
      },
      steps,
    }),
  );
  const res = spawnSync(python!, ['-I', DRIVER, script], { encoding: 'utf-8', timeout: 90_000 });
  let out: { ok: boolean; error?: string; screen?: string; screens?: string[] };
  try {
    out = JSON.parse(res.stdout);
  } catch {
    throw new Error(`pty driver failed: ${res.stderr || res.stdout}`);
  }
  if (!out.ok) throw new Error(`${out.error}\n--- screen ---\n${out.screen}`);
  return out.screens ?? [];
}

/** A copy of the home that first-run setup produced, with bob in the address book. */
let seeded = '';
function freshHome(): string {
  const home = mkdtempSync(join(work, 'home-'));
  cpSync(seeded, home, { recursive: true });
  return home;
}

describe.skipIf(!python)('terminal UI (pty, mock backend)', () => {
  beforeAll(() => {
    seeded = mkdtempSync(join(work, 'seed-'));
  });

  it('first-run setup: Wallet → Network → Token → Gas → Home, then quit with 0', () => {
    const screens = runTui(seeded, [
      { expect: 'Welcome to fhEVM Wallet' },
      { expect: 'no wallet yet' },
      { keys: '1' },
      { expect: 'Name this wallet' },
      { keys: 'alice\r' },
      { expect: 'Choose a password' },
      { keys: `${PASSWORD}\r` },
      { expect: 'Type the password again' },
      { keys: `${PASSWORD}\r` },
      { expect: 'Recovery phrase for alice', timeout: 30 },
      { sleep: 0.5 },
      { keys: 'x' },
      { expect: 'Which network' },
      { keys: '1' },
      { expect: 'suggested' },
      { keys: '1' },
      { expect: 'Finish setup', timeout: 15 },
      { keys: '1' },
      { expect: "You're set up" },
      { expect: 'decrypted', timeout: 15 },
      { keys: '0' },
      { exit: 0 },
    ]);
    expect(screens.at(-1)).toMatch(/Bye\. Your wallets stay encrypted/);
    const book = join(seeded, 'wallet-data', 'addressbook.json');
    writeFileSync(
      book,
      JSON.stringify({
        entries: [{ name: 'bob', address: BOB, addedAt: new Date().toISOString() }],
      }),
    );
    chmodSync(book, 0o600);
  });

  it('Home → Send → Esc back through each step keeping input → Ctrl+C → Home', () => {
    const screens = runTui(freshHome(), [
      { expect: 'Balances' },
      { keys: 's' },
      { expect: '● Token' },
      { keys: '\r' },
      { expect: '● Recipient' },
      { keys: '\r' },
      { expect: '● Amount' },
      { keys: '12.5\r' },
      { expect: '● Review' },
      ...esc(),
      { expect: '› 12.5' },
      ...esc(),
      { expect: 'Send cUSDC to' },
      ...esc(),
      { expect: '● Token' },
      { keys: '\r' },
      { expect: '● Recipient' },
      { keys: '\r' },
      { expect: '› 12.5' },
      { keys: CTRL_C },
      { expect: 'Cancelled. Back at Home' },
      { keys: CTRL_C },
      { expect: 'Ctrl+C again to quit' },
      { keys: CTRL_C },
      { exit: 0 },
    ]);
    expect(screens.length).toBeGreaterThan(10);
  });

  it('full send with countdown cancel, then resend: pending → confirmed, and repeat', () => {
    const home = freshHome();
    const screens = runTui(home, [
      { expect: 'Balances' },
      { keys: ':send bob 25 cusdc\r' },
      { expect: 'From the command bar' },
      { keys: '\r' },
      { expect: 'Password for alice' },
      { keys: `${PASSWORD}\r` },
      { expect: 'Simulation passed', timeout: 30 },
      { keys: '\r' },
      { expect: 'Sending 25.00 cUSDC to bob in' },
      ...esc(),
      { expect: 'Stopped. Nothing was sent' },
      { keys: '\r' },
      { expect: 'Esc stops it' },
      { expect: '1 pending', timeout: 10 },
      { expect: 'Sent 25.00 cUSDC to bob', timeout: 15 },
      { expect: 'Next time: fhew send bob 25 cusdc -n sepolia' },
      { expect: 'repeat last send', timeout: 5 },
      { keys: '.' },
      { expect: 'Repeating your last send' },
      { keys: CTRL_C },
      { keys: '0' },
      { exit: 0 },
    ]);
    expect(screens.join('\n')).toMatch(/cUSDC 1,225\.00/);

    // The printed "Next time" command works as printed.
    const hint =
      screens
        .join('\n')
        .match(/Next time: (fhew send [^\n]*)/)?.[1]
        .trim() ?? '';
    expect(hint).toBe('fhew send bob 25 cusdc -n sepolia');
    const out = runTui(
      home,
      [
        { expect: 'Enter wallet password', timeout: 20 },
        { keys: `${PASSWORD}\r` },
        { expect: 'Confirm transaction', timeout: 30 },
        { expect: 'MOCK: simulated, no real funds' },
        { keys: 'y\r' },
        { expect: 'Transfer confirmed (mock)', timeout: 20 },
        { exit: 0, timeout: 15 },
      ],
      {},
      hint.split(/\s+/).slice(1),
    );
    expect(out.join('\n')).toMatch(/Sent 25 cUSDC to bob/);
  });

  it('fhew send in a script: --password-stdin and --yes, friendly amount', () => {
    const home = freshHome();
    const res = spawnSync(
      process.execPath,
      [CLI, 'send', 'bob', 'half', 'cusdc', '--password-stdin', '--yes'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          FHEVM_WALLET_HOME: join(home, 'wallet-data'),
          FHEW_BACKEND: 'mock',
          FHEW_MOCK_LATENCY_MS: '20',
          FHEW_MOCK_CONFIRM_MS: '200',
        },
        input: `${PASSWORD}\n`,
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    expect(res.stdout).toMatch(/Sent 625 cUSDC to bob\. Transfer confirmed \(mock\)/);
    expect(res.status).toBe(0);
    // Without --yes and without a terminal, nothing is sent.
    const no = spawnSync(process.execPath, [CLI, 'send', 'bob', '1', '--password-stdin'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        FHEVM_WALLET_HOME: join(home, 'wallet-data'),
        FHEW_BACKEND: 'mock',
        FHEW_MOCK_LATENCY_MS: '20',
      },
      input: `${PASSWORD}\n`,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    expect(no.status).toBe(1);
    expect(no.stdout).toMatch(/Nothing was sent: confirm in a terminal, or pass --yes/);
    // -c picks the recipient; the positionals are then the amount and the token.
    const byContact = spawnSync(
      process.execPath,
      [CLI, 'send', '-c', 'bob', '3', 'cusdc', '--password-stdin', '--yes'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          FHEVM_WALLET_HOME: join(home, 'wallet-data'),
          FHEW_BACKEND: 'mock',
          FHEW_MOCK_LATENCY_MS: '20',
          FHEW_MOCK_CONFIRM_MS: '200',
        },
        input: `${PASSWORD}\n`,
        encoding: 'utf-8',
        timeout: 60_000,
      },
    );
    expect(byContact.stdout).toMatch(/Sent 3 cUSDC to bob\. Transfer confirmed \(mock\)/);
    expect(byContact.status).toBe(0);
  });

  it('fhew send on Mainnet: no unconfirmed send unless -n mainnet and --mainnet', () => {
    const home = freshHome();
    // Track the mock's Mainnet cUSDC (same derivation as MockBackend's mockAddress).
    const tokensFile = join(home, 'wallet-data', 'tokens.json');
    const reg = JSON.parse(readFileSync(tokensFile, 'utf-8'));
    const usdc = reg.tokens.find((t: { symbol: string }) => t.symbol === 'cUSDC');
    reg.tokens.push({
      ...usdc,
      network: 'mainnet',
      address: getAddress('0x' + id('fhew-mock:mainnet:cUSDC').slice(-40)),
    });
    writeFileSync(tokensFile, JSON.stringify(reg), { mode: 0o600 });
    // The default network is the trap: the command line never names Mainnet.
    const cfgFile = join(home, 'wallet-data', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf-8'));
    writeFileSync(cfgFile, JSON.stringify({ ...cfg, defaultNetwork: 'mainnet' }), { mode: 0o600 });

    const run = (...args: string[]) =>
      spawnSync(process.execPath, [CLI, 'send', 'bob', '1', 'cusdc', '--password-stdin', ...args], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          FHEVM_WALLET_HOME: join(home, 'wallet-data'),
          FHEW_BACKEND: 'mock',
          FHEW_MOCK_LATENCY_MS: '20',
          FHEW_MOCK_CONFIRM_MS: '200',
        },
        input: `${PASSWORD}\n`,
        encoding: 'utf-8',
        timeout: 60_000,
      });
    for (const args of [['--yes'], ['-n', 'mainnet', '--yes'], ['--mainnet', '--yes'], []]) {
      const res = run(...args);
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stdout).toMatch(/real funds on Mainnet without asking you/);
      expect(res.stdout).not.toMatch(/Transfer confirmed/);
    }
    const ok = run('-n', 'mainnet', '--mainnet', '--yes');
    expect(ok.stdout).toMatch(/Network: Ethereum Mainnet|Network: Mainnet/i);
    expect(ok.stdout).toMatch(/Sent 1 cUSDC to bob\. Transfer confirmed \(mock\)/);
    expect(ok.status).toBe(0);
    // Sepolia is unaffected: -n sepolia --yes needs no --mainnet.
    const sep = run('-n', 'sepolia', '--yes');
    expect(sep.stdout).toMatch(/Sent 1 cUSDC to bob\. Transfer confirmed \(mock\)/);
    expect(sep.status).toBe(0);

    // In a terminal without --yes, Mainnet asks to retype the amount.
    const screens = runTui(
      home,
      [
        { expect: 'Enter wallet password', timeout: 20 },
        { keys: `${PASSWORD}\r` },
        { expect: 'Confirm transaction', timeout: 30 },
        { keys: 'y\r' },
        { expect: 'Type the amount again' },
        { keys: '2\r' },
        { expect: "Nothing was sent: that doesn't match 1 cUSDC", timeout: 10 },
        { exit: 1, timeout: 15 },
      ],
      {},
      ['send', 'bob', '1', 'cusdc'],
    );
    expect(screens.join('\n')).not.toMatch(/Transfer confirmed/);
  });

  it('fhew interactive -n mainnet starts on Mainnet (the flag after the command)', () => {
    const screens = runTui(
      freshHome(),
      [{ expect: 'Balances' }, { expect: ' MAINNET ' }, { keys: '0' }, { exit: 0 }],
      {},
      ['interactive', '-n', 'mainnet'],
    );
    expect(screens.join('\n')).not.toMatch(/ Sepolia /);
  });

  it('stops on a look-alike of a contact', () => {
    runTui(freshHome(), [
      { expect: 'Balances' },
      { keys: 's' },
      { expect: '● Token' },
      { keys: '\r' },
      { expect: 'Paste an address' },
      { keys: 'p' },
      { expect: 'Paste the recipient address' },
      { keys: `${BOB_LOOKALIKE}\r` },
      { expect: 'looks like your contact bob, but it is a different address' },
      { keys: '1' },
      { expect: 'to send to bob' },
      { keys: CTRL_C },
      { keys: '0' },
      { exit: 0 },
    ]);
  });

  it('lock and unlock, ? help and the command bar', () => {
    runTui(freshHome(), [
      { expect: 'Balances' },
      { keys: 'b' },
      { expect: 'Unlock and refresh' },
      { keys: '\r' },
      { expect: 'Password for alice' },
      { keys: 'wrong password\r' },
      { expect: 'did not unlock alice', timeout: 30 },
      { keys: `${PASSWORD}\r` },
      { expect: 'unlocked 15m', timeout: 30 },
      { expect: '1 token(s) decrypted' },
      { expect: 'cUSDC      1,250.00' },
      { keys: 'L' },
      { expect: 'Locked. Your password is needed' },
      { expect: 'Unlock and refresh' },
      { keys: '?' },
      { expect: 'Keys on this screen' },
      { keys: 'x' },
      { absent: 'Keys on this screen' },
      { keys: ':' },
      { expect: 'send bob 25 cusdc · balances' },
      { keys: 'doctor\r' },
      { expect: 'Data folder is owner-only', timeout: 15 },
      { keys: ':quit\r' },
      { exit: 0 },
    ]);
  });

  it('a lost confirmation keeps the hash and never says try again', () => {
    const screens = runTui(
      freshHome(),
      [
        { expect: 'Balances' },
        { keys: ':send bob 1\r' },
        { expect: 'Confirm and sign' },
        { keys: '\r' },
        { keys: `${PASSWORD}\r` },
        { expect: 'Simulation passed', timeout: 30 },
        { keys: '\r' },
        { expect: 'Press e for details', timeout: 20 },
        { keys: 'e' },
        { expect: 'handed to the network' },
        { expect: 'https://sepolia.etherscan.io/tx/0x' },
        { absent: 'Try again' },
        { keys: CTRL_C },
        { keys: '0' },
        { exit: 0 },
      ],
      { FHEW_MOCK_FAIL: 'unconfirmed' },
    );
    expect(screens.join('\n')).toMatch(/Transaction +0x[0-9a-f]{64}/);
  });

  it('draws at 80x24 when the terminal reports 0x0', () => {
    const home = freshHome();
    const script = join(work, 'zero.json');
    writeFileSync(
      script,
      JSON.stringify({
        argv: [process.execPath, CLI],
        cols: 0,
        rows: 0,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          FHEVM_WALLET_HOME: join(home, 'wallet-data'),
          TERM: 'xterm',
          FHEW_BACKEND: 'mock',
        },
        steps: [{ expect: '0  Quit' }, { keys: '0' }, { exit: 0 }],
      }),
    );
    const res = spawnSync(python!, ['-I', DRIVER, script], { encoding: 'utf-8', timeout: 60_000 });
    expect(JSON.parse(res.stdout).ok).toBe(true);
  });

  it('refuses the mock backend without a separate FHEVM_WALLET_HOME', () => {
    const home = freshHome();
    const script = join(work, 'nomockhome.json');
    writeFileSync(
      script,
      JSON.stringify({
        argv: [process.execPath, CLI],
        env: { PATH: process.env.PATH ?? '', HOME: home, TERM: 'xterm', FHEW_BACKEND: 'mock' },
        steps: [{ expect: 'needs FHEVM_WALLET_HOME' }, { exit: 1 }],
      }),
    );
    let out = JSON.parse(
      spawnSync(python!, ['-I', DRIVER, script], { encoding: 'utf-8', timeout: 60_000 }).stdout,
    );
    expect(out.ok).toBe(true);
    expect(out.screens.join('\n')).toMatch(/mktemp -d/);
    // Pointing it at the real folder is refused too.
    writeFileSync(
      script,
      JSON.stringify({
        argv: [process.execPath, CLI],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          TERM: 'xterm',
          FHEW_BACKEND: 'mock',
          FHEVM_WALLET_HOME: join(home, '.fhevm-wallet'),
        },
        steps: [{ expect: 'real wallet folder' }, { exit: 1 }],
      }),
    );
    out = JSON.parse(
      spawnSync(python!, ['-I', DRIVER, script], { encoding: 'utf-8', timeout: 60_000 }).stdout,
    );
    expect(out.ok).toBe(true);
  });

  it('Tokens › Find tokens: multi-select with a (all) and Enter bulk-adds', () => {
    const screens = runTui(freshHome(), [
      { expect: 'Balances' },
      { keys: ':tokens\r' },
      { expect: 'Find tokens' },
      { keys: '3' },
      { expect: 'found in your history · unverified', timeout: 20 },
      { expect: 'not ERC-7984, not offered' },
      { keys: 'a' },
      { expect: '[x] cGIFT' },
      { keys: '\r' },
      { expect: 'Added cDAI, cGIFT', timeout: 10 },
      { keys: CTRL_C },
      { keys: '0' },
      { exit: 0 },
    ]);
    expect(screens.join('\n')).toMatch(/1 already tracked/);
  });

  it('keeps mock and real data apart, whatever the settings files say', () => {
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, [CLI, ...args], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf-8',
        timeout: 30_000,
      });
    const home = freshHome();
    const mockDir = join(home, 'wallet-data');
    // A mock folder is refused for real use, by every command.
    for (const args of [['wallet', 'list'], ['balance']]) {
      const res = run(args, { HOME: home, FHEVM_WALLET_HOME: mockDir });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/holds simulated data from FHEW_BACKEND=mock/);
    }
    // Under the mock, commands that would reach the real network are refused.
    const bal = run(['balance'], { HOME: home, FHEVM_WALLET_HOME: mockDir, FHEW_BACKEND: 'mock' });
    expect(bal.status).toBe(1);
    expect(bal.stderr).toMatch(/would use the real network/);
    // A real folder with data is never turned into a mock folder.
    const realDir = join(home, 'real-data');
    expect(run(['wallet', 'list'], { HOME: home, FHEVM_WALLET_HOME: realDir }).status).toBe(0);
    writeFileSync(join(realDir, 'tokens.json'), '{"tokens":[]}');
    const mixed = run(['wallet', 'list'], {
      HOME: home,
      FHEVM_WALLET_HOME: realDir,
      FHEW_BACKEND: 'mock',
    });
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toMatch(/not a mock folder/);
    // FHEW_BACKEND in a .env file does not switch to the mock.
    writeFileSync(join(realDir, '.env'), 'FHEW_BACKEND=mock\n');
    chmodSync(join(realDir, '.env'), 0o600);
    const viaEnv = run(['wallet', 'list'], { HOME: home, FHEVM_WALLET_HOME: realDir });
    expect(viaEnv.stdout + viaEnv.stderr).not.toMatch(/mock/i);
  });

  it('refuses to start without a terminal and says what to do', () => {
    const res = spawnSync(process.execPath, [CLI], {
      env: { PATH: process.env.PATH ?? '', HOME: freshHome() },
      encoding: 'utf-8',
      input: '',
      timeout: 30_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/needs a terminal/);
  });
});

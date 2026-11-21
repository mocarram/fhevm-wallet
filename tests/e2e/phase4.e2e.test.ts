/**
 * End-to-end runs of the Phase 4a commands against the offline mock backend:
 * `fhew doctor`, `--json` output, `fhew token find` and the ERC-7984 check on add.
 * Nothing here talks to a real network.
 */

import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAddress, id } from 'ethers';
import { runCli, tempHome } from './helpers.js';

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';
/** Same derivation as MockBackend's mock addresses. */
const mockAddress = (label: string) => getAddress('0x' + id(`fhew-mock:${label}`).slice(-40));
const PLAIN = mockAddress('sepolia:plain-erc20');

let t: ReturnType<typeof tempHome>;
let env: Record<string, string>;
beforeEach(() => {
  t = tempHome();
  env = {
    FHEW_BACKEND: 'mock',
    FHEVM_WALLET_HOME: join(t.home, 'wallet-data'),
    FHEW_MOCK_LATENCY_MS: '5',
  };
});
afterEach(() => t.cleanup());

const json = (args: string[], extra: Record<string, string> = {}) => {
  const r = runCli([...args, '--json'], t.home, { ...env, ...extra });
  let doc: unknown;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    throw new Error(`not JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  }
  return { ...r, doc: doc as Record<string, unknown> & { error?: { code: string } } };
};

describe('fhew doctor (mock)', () => {
  it('passes, prints plain words, and exits 1 when the RPC is down', () => {
    const ok = runCli(['doctor'], t.home, env);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/MOCK/);
    expect(ok.stdout).toMatch(/Node\.js v24/);
    expect(ok.stdout).toMatch(/Zama relayer mock:\/\/relayer answers/);
    const down = runCli(['doctor'], t.home, { ...env, FHEW_MOCK_FAIL: 'rpc' });
    expect(down.code).toBe(1);
    expect(down.stdout).toMatch(/No RPC endpoint works for this network/);
  });

  it('--json has stable keys and no colour codes', () => {
    const r = json(['doctor']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/\u001b\[/);
    expect(r.doc).toMatchObject({ network: 'sepolia', mock: true, ok: true });
    const checks = r.doc.checks as Array<{ id: string; status: string }>;
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(['node', 'data-dir', 'rpc.0', 'relayer']));
  });
});

describe('fhew token find and add (mock)', () => {
  it('lists labelled candidates, adds the verified ones, and resumes the scan', () => {
    const r = json(['token', 'find', '-a', ADDR]);
    expect(r.code).toBe(0);
    const c = r.doc.candidates as Array<{ symbol: string; status: string; sources: string[] }>;
    expect(c.map((x) => [x.symbol, x.status])).toEqual([
      ['cDAI', 'verified'],
      ['cUSDC', 'verified'],
      ['cGIFT', 'unverified'],
      ['PLAIN', 'not-erc7984'],
    ]);
    expect(c[0].sources).toEqual(['known', 'history']);
    const add = json(['token', 'find', '-a', ADDR, '--all-verified']);
    expect(add.doc.added).toHaveLength(2);
    expect((add.doc.scan as { upToDate: boolean }).upToDate).toBe(true);
    const list = json(['token', 'list']);
    expect((list.doc.tokens as Array<{ symbol: string }>).map((x) => x.symbol).sort()).toEqual([
      'cDAI',
      'cUSDC',
    ]);
    // A token failing the check is refused even with --add, unless --force.
    const refused = json(['token', 'find', '-a', ADDR, '--add', PLAIN]);
    expect(refused.code).toBe(1);
    expect((refused.doc.skipped as Array<{ reason: string }>)[0].reason).toMatch(/--force/);
    const text = runCli(['token', 'find', '-a', ADDR], t.home, env);
    expect(text.stdout).toMatch(/found in your history/);
    expect(text.stdout).toMatch(/unverified/);
  });

  it('token add refuses a non-ERC-7984 contract unless --force', () => {
    const no = runCli(['token', 'add', PLAIN], t.home, env);
    expect(no.code).toBe(1);
    expect(no.stdout).toMatch(/does not look like an ERC-7984 confidential token/);
    expect(no.stdout).toMatch(/--force/);
    const yes = runCli(['token', 'add', PLAIN, '--force'], t.home, env);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toMatch(/Added anyway/);
  });
});

describe('--json on other commands', () => {
  it('wallet list, receive and errors', () => {
    expect(json(['wallet', 'list']).doc).toEqual({ wallets: [] });
    const r = json(['receive']);
    expect(r.code).toBe(1);
    expect(r.doc).toEqual({ error: { code: 'NO_WALLET', message: expect.any(String) } });
    const send = json(['send', 'bob', '1']);
    expect(send.code).toBe(1);
    expect(send.doc.error?.code).toBe('PROMPT_NOT_ALLOWED');
  });

  it('config --show masks the RPC key (real backend, no network)', () => {
    const key = 'e2eSecretKey1234567890abcd';
    const r = runCli(['config', '--show', '--json'], t.home, {
      FHEVM_WALLET_HOME: join(t.home, 'real-data'),
      SEPOLIA_RPC_URL: `https://rpc.example/v3/${key}`,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(key);
    expect(JSON.parse(r.stdout).rpc.sepolia.url).toBe('https://rpc.example/…');
  });
});

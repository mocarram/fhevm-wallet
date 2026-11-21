/**
 * Regression: `-n/--network` after the subcommand used to be swallowed by the program's
 * global option, so commands silently used the configured default network. Each command
 * that takes a network is run with the default set to the other network. None of these
 * runs reach an RPC: each stops at a local check that names the network it used.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, tempHome } from './helpers.js';

const SEPOLIA_TOKEN = '0x52908400098527886E0F7030069857D2E4169EE7';
const MAINNET_TOKEN = '0xde709f2102306220921060314715629080e2fb77';
const WALLET = '0x000000000000000000000000000000000000dEaD';

let cleanup: () => void = () => {};
afterEach(() => cleanup());

/** A fresh home whose default network is `defaultNetwork`, with one token per network. */
function home(defaultNetwork: 'sepolia' | 'mainnet', withTokens = true): string {
  const t = tempHome();
  cleanup = t.cleanup;
  const set = runCli(['config', '--network', defaultNetwork], t.home);
  expect(set.stdout).toMatch(`Default network set to ${defaultNetwork}`);
  if (withTokens) {
    const dir = join(t.home, '.fhevm-wallet');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = (address: string, symbol: string, network: string) => ({
      address,
      name: symbol,
      symbol,
      decimals: 6,
      network,
      addedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dir, 'tokens.json'),
      JSON.stringify({
        tokens: [entry(SEPOLIA_TOKEN, 'SEPT', 'sepolia'), entry(MAINNET_TOKEN, 'MAINT', 'mainnet')],
      }),
      { mode: 0o600 },
    );
  }
  return t.home;
}

const tokensIn = (h: string) =>
  JSON.parse(readFileSync(join(h, '.fhevm-wallet', 'tokens.json'), 'utf-8')).tokens as Array<{
    network: string;
  }>;

describe('-n/--network after the subcommand is used', () => {
  it('config --network sets the default network', () => {
    const h = home('mainnet', false);
    expect(runCli(['config', '--show'], h).stdout).toMatch(/Default network: mainnet/);
    runCli(['config', '--network', 'sepolia'], h);
    expect(runCli(['config', '--show'], h).stdout).toMatch(/Default network: sepolia/);
  });

  it('balance -n sepolia does not use the Mainnet default', () => {
    const h = home('mainnet');
    // Mainnet needs a Zama API key; Sepolia goes on to look for a wallet.
    expect(runCli(['balance'], h).stdout).toMatch(/Zama API key/);
    const res = runCli(['balance', '-n', 'sepolia'], h);
    expect(res.stdout).not.toMatch(/Zama API key/);
    expect(res.stdout).toMatch(/No wallets found/);
  });

  it('history -n mainnet looks at Mainnet', () => {
    const h = home('sepolia', false);
    const res = runCli(['history', '-n', 'mainnet', '-a', WALLET], h);
    expect(res.stdout).toMatch(/No tokens tracked on mainnet/);
  });

  it('token list -n mainnet lists only Mainnet tokens', () => {
    const h = home('sepolia');
    const res = runCli(['token', 'list', '-n', 'mainnet', '--full'], h);
    expect(res.stdout).toMatch(/MAINT/);
    expect(res.stdout).not.toMatch(/SEPT/);
  });

  it('token add -n mainnet checks Mainnet', () => {
    const h = home('sepolia');
    const res = runCli(['token', 'add', MAINNET_TOKEN, '-n', 'mainnet'], h);
    expect(res.stdout).toMatch(/already tracked on mainnet/);
  });

  it('token remove -n mainnet removes the Mainnet entry', () => {
    const h = home('sepolia');
    const res = runCli(['token', 'remove', MAINNET_TOKEN, '-n', 'mainnet', '-f'], h);
    expect(res.code).toBe(0);
    expect(tokensIn(h).map((t) => t.network)).toEqual(['sepolia']);
  });
});

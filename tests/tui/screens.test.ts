import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it } from 'vitest';
import { listWallets } from '../../src/core/wallet/WalletManager.js';
import { listTokens } from '../../src/core/token/TokenRegistry.js';
import { listAddresses } from '../../src/storage/AddressBook.js';
import { loadUiPrefs } from '../../src/storage/UiPrefsStore.js';
import { getEnvVar } from '../../src/storage/paths.js';
import { render } from '../../src/tui/app.js';
import { SCREENS } from '../../src/tui/screens/registry.js';
import { breadcrumb, statusBar } from '../../src/tui/statusBar.js';
import { plain } from '../../src/tui/text.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

describe('every screen', () => {
  for (const id of Object.keys(SCREENS)) {
    it(`${id} renders locked, unlocked, on mainnet and at 40 columns`, () => {
      for (const variant of ['locked', 'unlocked', 'mainnet', 'narrow'] as const) {
        const h = new Harness({ unlocked: variant !== 'locked' });
        if (variant === 'mainnet') h.s.network = 'mainnet';
        h.s.stack.push({ id, cur: 0, params: { address: STRANGER, contact: 'bob' } });
        const cols = variant === 'narrow' ? 40 : 100;
        const lines = render(h.s, { cols, rows: 30 }).map(plain);
        expect(lines).toHaveLength(30);
        for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(cols);
        expect(lines[0]).toMatch(/fhEVM Wallet/);
      }
    });
  }
});

describe('status bar', () => {
  it('shows breadcrumb, MOCK, network, wallet, lock state and ETH', () => {
    const h = new Harness({ unlocked: true });
    h.s.eth = { wei: 421n * 10n ** 15n, at: h.now };
    h.s.stack.push({ id: 'send-review', cur: 0, params: {} });
    expect(breadcrumb(h.s)).toBe('Home › Send › Review');
    const bar = plain(statusBar(h.s, 120));
    expect(bar).toMatch(/MOCK/);
    expect(bar).toMatch(/Sepolia/);
    expect(bar).toMatch(/alice 0x/);
    expect(bar).toMatch(/unlocked 15m/);
    expect(bar).toMatch(/0\.4210 ETH/);
    expect(Array.from(bar).length).toBe(120);
  });

  it('uses the red MAINNET style, yellow low ETH, and a pending spinner', () => {
    const h = new Harness();
    h.s.network = 'mainnet';
    h.s.eth = { wei: 10n ** 14n, at: h.now };
    h.s.pending.push({ id: 1, amountText: '1 cUSDC', toLabel: 'bob' });
    const segs = statusBar(h.s, 120);
    expect(segs.find((g) => g.t.includes('MAINNET'))?.s).toContain('mainnet');
    expect(segs.find((g) => g.t.includes('ETH'))?.s).toContain('low');
    expect(plain(segs)).toMatch(/1 pending/);
    expect(plain(segs)).toMatch(/locked/);
  });

  it('shrinks to fit narrow terminals', () => {
    const h = new Harness();
    h.s.stack.push({ id: 'settings-rpc-url', cur: 0, params: {} });
    expect(Array.from(plain(statusBar(h.s, 70))).length).toBeLessThanOrEqual(70);
  });
});

describe('Home', () => {
  it('nudges when ETH is low and shows balances with their age', () => {
    const h = new Harness();
    h.s.eth = { wei: 10n ** 14n, at: h.now };
    h.s.balances[h.s.data.tokens[0].address.toLowerCase()] = {
      value: 5_000_000n,
      at: h.now - 3 * 60_000,
      source: 'cache',
    };
    const t = h.text();
    expect(t).toMatch(/Low on gas: 0\.0001 ETH covers about 0 more sends/);
    expect(t).toMatch(/cUSDC 5\.00/);
    expect(t).toMatch(/cached 3m ago · unlock to refresh/);
  });
});

describe('Balances and unlock', () => {
  it('unlocked: decrypts on open and refreshes on request', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    expect(h.text()).toMatch(/cUSDC +1,250\.00/);
    expect(h.text()).toMatch(/1 token\(s\) decrypted/);
    await h.keys('1');
    expect(h.ran.filter((k) => k === 'decrypt')).toHaveLength(2);
  });

  it('locked: offers to unlock and explains cached values', async () => {
    const h = new Harness();
    await h.keys('b');
    expect(h.text()).toMatch(/Locked\. Unlock to decrypt/);
    await h.keys('{enter}');
    expect(h.screen).toBe('unlock');
    await h.keys('{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/Type your wallet password/);
  });
});

describe('Wallets', () => {
  it('creates a wallet, shows the phrase on the secret screen, and switches to it locked', async () => {
    const h = new Harness();
    await h.keys('5', '2');
    expect(h.screen).toBe('wallet-name');
    await h.keys('bad name!');
    expect(h.s.inputs.walletName).toBe('badname');
    await h.keys('{ctrl-u}', 'savings', '{enter}', 'short', '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/at least 8/);
    await h.keys('{ctrl-u}', 'long password 1', '{enter}', 'different', '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/don't match/);
    expect(h.s.inputs.password2).toBeUndefined();
    await h.keys('long password 1', '{enter}');
    expect(h.secrets[0].title).toBe('Recovery phrase for savings');
    expect(h.secrets[0].lines.join(' ')).toMatch(/ 1 \w+/);
    expect(h.screen).toBe('wallets');
    expect(h.s.wallet?.name).toBe('savings');
    expect(h.s.signer).toBeNull();
    expect(h.s.inputs.password).toBeUndefined();
    expect(listWallets().map((w) => w.name)).toEqual(['savings']);

    // Unlock with the real keystore through the Balances screen.
    await h.keys('{ctrl-c}', 'b', '{enter}', 'long password 1', '{enter}');
    expect(h.s.signer?.address).toBe(h.s.wallet?.address);
    expect(h.screen).toBe('balances');

    // Export the key: password, then the wipe-on-keypress screen.
    await h.keys('{ctrl-c}', '5', '4', '1', 'long password 1', '{enter}');
    expect(h.secrets[1].title).toBe('Private key for savings');
    expect(h.secrets[1].lines[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.text()).toMatch(/Screen wiped/);

    // Encrypted keystore export never overwrites.
    const target = join(tmpdir(), `fhew-tui-test-${Date.now()}.json`);
    await h.keys('4', '2', '{ctrl-u}');
    h.s.inputs.exportPath = target;
    await h.keys('{enter}');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o077).toBe(0);
    await h.keys('4', '2', '{ctrl-u}');
    h.s.inputs.exportPath = target;
    await h.keys('{enter}');
    expect(h.screen).toBe('export-keystore');
    expect(h.s.fieldError).not.toBeNull();

    // Remove needs the exact name typed.
    await h.keys('{escape}', '{escape}', '5', 'saving', '{enter}');
    expect(h.screen).toBe('wallet-remove');
    expect(h.s.fieldError?.[0]).toMatch(/Type savings exactly/);
    await h.keys('s', '{enter}');
    expect(listWallets()).toHaveLength(0);
    expect(h.screen).toBe('setup-welcome');
    expect(h.s.setup).toBe(true);
  });

  it('imports from a private key', async () => {
    const h = new Harness();
    await h.keys('5', '3', '2', 'nothex', '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/not a private key/);
    await h.keys('{ctrl-u}', '0x' + '1'.repeat(64), '{enter}');
    expect(h.screen).toBe('wallet-name');
    await h.keys('imp', '{enter}', 'long password 1', '{enter}', 'long password 1', '{enter}');
    expect(listWallets().map((w) => w.name)).toEqual(['imp']);
    expect(h.s.inputs.importSecret).toBeUndefined();
    expect(h.text()).toMatch(/Imported imp/);
  });
});

describe('Tokens', () => {
  it('adds a token by address and removes several with the multi-select', async () => {
    const h = new Harness();
    const cdai = h.backend.catalogue('sepolia')[1];
    await h.keys('6', '1', cdai.address, '{enter}');
    expect(h.screen).toBe('tokens');
    expect(h.text()).toMatch(/Added cDAI \(Confidential DAI\)/);
    expect(listTokens('sepolia')).toHaveLength(2);

    await h.keys('1', cdai.address, '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/already tracked/);

    await h.keys('{escape}', '2', '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/Nothing selected/);
    await h.keys('a', '{enter}');
    expect(listTokens('sepolia')).toHaveLength(0);
    expect(h.text()).toMatch(/Stopped tracking cUSDC, cDAI/);
  });

  it('shows Find tokens as a disabled slot', async () => {
    const h = new Harness();
    await h.keys('6');
    expect(h.text()).toMatch(/3 {2}Find tokens +coming soon/);
    await h.keys('3');
    expect(h.screen).toBe('tokens');
    expect(h.text()).toMatch(/coming in a later update/);
  });

  it('explains when the token cannot be read', async () => {
    const h = new Harness({ mock: { fail: 'rpc' } });
    await h.keys('6', '1', STRANGER, '{enter}');
    expect(h.screen).toBe('token-add');
    expect(h.s.fieldError?.[0]).toMatch(/Couldn't add that token/);
  });
});

describe('Address book', () => {
  it('adds and removes a contact', async () => {
    const h = new Harness();
    await h.keys('7', '1', 'carol', '{enter}', STRANGER, '{enter}');
    expect(h.screen).toBe('contacts');
    expect(listAddresses().map((c) => c.name)).toContain('carol');
    await h.keys('1', 'Carol', '{enter}');
    expect(h.s.fieldError?.[0]).toMatch(/already have a contact/);
    await h.keys('{escape}', '2', '2');
    expect(listAddresses().map((c) => c.name)).toEqual(['bob']);
  });
});

describe('Settings', () => {
  it('cycles unlock duration and countdown, saved to preferences', async () => {
    const h = new Harness();
    await h.keys('8', '6');
    expect(loadUiPrefs().unlockMinutes).toBe(60);
    await h.keys('7');
    expect(loadUiPrefs().countdownSeconds).toBe(10);
    expect(h.text()).toMatch(/Mainnet always counts down at least 5 s/);
  });

  it('switches network with a warning on mainnet and back', async () => {
    const h = new Harness();
    await h.keys('8', '1', '2');
    expect(h.s.network).toBe('mainnet');
    expect(h.text()).toMatch(/real funds/);
    expect(h.text()).toMatch(/MAINNET/);
    await h.keys('1');
    expect(h.s.network).toBe('sepolia');
  });

  it('saves an API key without ever showing it', async () => {
    const h = new Harness();
    await h.keys('8', '4', 'ABCDEF123456');
    expect(h.text()).not.toMatch(/ABCDEF123456/);
    await h.keys('{enter}');
    expect(getEnvVar('ETHERSCAN_API_KEY')).toBe('ABCDEF123456');
    expect(h.s.inputs.apiKey).toBeUndefined();
    expect(h.text()).toMatch(/Etherscan key +set/);
  });

  it('checks the RPC endpoint and refuses non-https URLs', async () => {
    const h = new Harness();
    await h.keys('8', '3', '1');
    expect(h.text()).toMatch(/RPC answers with chain id 11155111/);
    await h.keys('2', 'http://insecure.example', '{enter}');
    expect(h.screen).toBe('settings-rpc-url');
    expect(h.s.fieldError).not.toBeNull();
  });
});

describe('History, Receive and Doctor', () => {
  it('History syncs and lists transfers', async () => {
    const h = new Harness();
    await h.keys('h');
    expect(h.text()).toMatch(/received/);
    expect(h.s.history?.loading).toBe(false);
  });

  it('Receive shows the address and copies it', async () => {
    const h = new Harness();
    await h.keys('r');
    expect(h.text()).toContain(h.signer.address);
    await h.keys('1');
    expect(h.text()).toMatch(/terminal clipboard/);
    await h.keys('2');
    expect(h.text()).toMatch(/faucet/i);
  });

  it('Doctor runs its checks', async () => {
    const h = new Harness();
    await h.keys('d');
    expect(h.text()).toMatch(/Node\.js v/);
    expect(h.text()).toMatch(/RPC reachable/);
    expect(h.text()).toMatch(/simulated/);
  });
});

describe('first-run setup', () => {
  it('Wallet → Network → Token → Gas → Home', async () => {
    const h = new Harness({ noWallet: true, seed: false, mock: { ethWei: 0n } });
    expect(h.screen).toBe('setup-welcome');
    expect(h.text()).toMatch(/no wallet yet/);
    expect(h.text()).not.toMatch(/Home ›/);
    await h.keys(':balances{enter}');
    expect(h.text()).toMatch(/Finish setup first/);
    await h.keys(
      '1',
      'alice',
      '{enter}',
      'long password 1',
      '{enter}',
      'long password 1',
      '{enter}',
    );
    expect(h.secrets[0].title).toMatch(/Recovery phrase/);
    expect(h.screen).toBe('setup-network');
    expect(h.s.signer).not.toBeNull();
    await h.keys('1');
    expect(h.screen).toBe('setup-token');
    expect(h.text()).toMatch(/cUSDC {2}Confidential USDC +suggested/);
    await h.keys('1');
    expect(h.screen).toBe('setup-gas');
    // The mock reports 0 ETH on the first look and drips faucet ETH afterwards.
    const funded = h.s.eth;
    h.s.eth = { wei: 0n, at: h.now };
    expect(h.text()).toMatch(/0 ETH\. Every send needs a little ETH/);
    expect(h.text()).toMatch(/Finish without ETH/);
    h.s.eth = funded;
    expect(h.text()).toMatch(/0\.5000 ETH available/);
    await h.keys('1');
    expect(h.screen).toBe('home');
    expect(h.s.setup).toBe(false);
    expect(h.text()).toMatch(/You're set up/);
    expect(h.text()).toMatch(/cUSDC 1,250\.00/);
  });
});

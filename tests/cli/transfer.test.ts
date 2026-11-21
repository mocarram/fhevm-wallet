import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { retypeMatches, shiftForContact } from '../../src/cli/commands/transfer.js';
import { addAddress } from '../../src/storage/AddressBook.js';
import { saveConfig } from '../../src/storage/ConfigStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const KNOWN_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const OTHER_ADDRESS = '0xde709f2102306220921060314715629080e2fb77';

let logSpy: ReturnType<typeof vi.spyOn>;

function seedToken(network: 'sepolia' | 'mainnet', address: string): void {
  // Bypass the registry's RPC-backed addToken() by writing the file directly.
  const dir = join(homedir(), '.fhevm-wallet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'tokens.json'),
    JSON.stringify({
      tokens: [
        {
          address,
          name: 'Mock Token',
          symbol: 'MOCK',
          decimals: 6,
          network,
          addedAt: new Date().toISOString(),
        },
      ],
    }),
  );
}

async function runSend(...args: string[]): Promise<string> {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(['node', 'fhevm-wallet', 'send', ...args]);
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  wipeTestDataDir();
  delete process.env.ZAMA_MAINNET_API_KEY;
});

afterEach(() => {
  logSpy?.mockRestore();
});

describe('send command early exits', () => {
  it('reports "No tokens tracked" when registry is empty', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runSend();
    expect(out).toMatch(/No tokens tracked on sepolia/);
  });

  it('rejects an invalid token address, and an unknown symbol (registry must be non-empty)', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    expect(await runSend('--token', '0xnot-an-address')).toMatch(/Invalid token address/);
    logSpy.mockRestore();
    expect(await runSend('--token', 'cxyz')).toMatch(/No tracked token called "cxyz". Try mock/);
    logSpy.mockRestore();
    expect(await runSend('bob', '1', 'cxyz')).toMatch(/No tracked token called "cxyz"/);
  });

  it('rejects a token not in the registry', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', OTHER_ADDRESS);
    const out = await runSend('--token', KNOWN_ADDRESS);
    expect(out).toMatch(/not tracked/);
  });

  it('rejects a missing contact', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    const out = await runSend('--token', KNOWN_ADDRESS, '--contact', 'ghost');
    expect(out).toMatch(/Contact "ghost" not found/);
  });

  it('rejects a malformed positional recipient', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    expect(await runSend('0xnot-an-address', '1', '--token', KNOWN_ADDRESS)).toMatch(
      /not a valid address/,
    );
    logSpy.mockRestore();
    expect(await runSend('nobody', '1', 'mock')).toMatch(/No contact called "nobody"/);
  });

  it('stops on a look-alike of a contact without a terminal', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    addAddress('bob', '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF');
    const out = await runSend('0x91bE9f71c0aE2B58d4a3f6C0B9e1D7a5f33207Af', '1', 'mock');
    expect(out).toMatch(/looks like your contact bob/);
    expect(out).toMatch(/Send stopped\. To send to bob, use: fhew send bob/);
  });

  it('rejects mainnet send without ZAMA API key (FHE readiness)', async () => {
    saveConfig({ defaultNetwork: 'mainnet' });
    const out = await runSend('-n', 'mainnet', '--mainnet');
    expect(out).toMatch(/Zama API key/);
  });

  it('refuses an unconfirmed Mainnet send picked by the default network', async () => {
    saveConfig({ defaultNetwork: 'mainnet' });
    // No terminal in tests, so nobody would be asked: the guard runs first.
    expect(await runSend('bob', '1', '--yes')).toMatch(/pass both -n mainnet and --mainnet/);
    logSpy.mockRestore();
    expect(await runSend('bob', '1', '-n', 'mainnet', '--yes')).toMatch(/--mainnet/);
    logSpy.mockRestore();
    expect(await runSend('bob', '1', '--mainnet', '--yes')).toMatch(/-n mainnet/);
  });

  it('honours -n after the command (regression: it was ignored for the default)', async () => {
    saveConfig({ defaultNetwork: 'mainnet' });
    const out = await runSend('bob', '1', '-n', 'sepolia', '--yes');
    expect(out).not.toMatch(/Mainnet/);
    expect(out).toMatch(/No tokens tracked on sepolia/);
  });

  it('uses contact lookup to resolve a recipient', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    addAddress('Alice', OTHER_ADDRESS);

    // After contact + amount + token are resolved, the action enters wallet
    // selection prompt. Stub the prompts to throw so we don't hang, then assert
    // the contact line was already logged.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompts } = await import('../../src/cli/utils/prompts.js');
    const fence = new Error('prompt-fence');
    const promptSpies = [
      vi.spyOn(prompts, 'select').mockRejectedValue(fence),
      vi.spyOn(prompts, 'input').mockRejectedValue(fence),
      vi.spyOn(prompts, 'password').mockRejectedValue(fence),
    ];

    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program
      .parseAsync([
        'node',
        'fhevm-wallet',
        'send',
        '--token',
        KNOWN_ADDRESS,
        '--contact',
        'Alice',
        '1',
      ])
      .catch(() => {});

    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toMatch(/Using contact: Alice/);
    promptSpies.forEach((spy) => spy.mockRestore());
  });
});

describe('retypeMatches', () => {
  it('accepts the same amount in any friendly form and nothing else', () => {
    expect(retypeMatches('25', 25_000_000n, 6)).toBe(true);
    expect(retypeMatches('25.000000', 25_000_000n, 6)).toBe(true);
    expect(retypeMatches('25.1', 25_000_000n, 6)).toBe(false);
    expect(retypeMatches('', 25_000_000n, 6)).toBe(false);
  });
});

describe('shiftForContact (-c with positionals)', () => {
  const bob = { name: 'bob', address: '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF' };
  it('reads the positionals as [amount] [token] after -c', () => {
    expect(shiftForContact(bob, '3', undefined, undefined)).toEqual({ ok: true, amount: '3' });
    expect(shiftForContact(bob, '2', 'cusdc', undefined)).toEqual({
      ok: true,
      amount: '2',
      token: 'cusdc',
    });
    expect(shiftForContact(bob, undefined, undefined, undefined)).toEqual({ ok: true });
  });
  it('accepts the same contact again, by name or address', () => {
    expect(shiftForContact(bob, 'Bob', '2', 'cusdc')).toMatchObject({
      amount: '2',
      token: 'cusdc',
    });
    expect(shiftForContact(bob, bob.address.toLowerCase(), '2', undefined)).toMatchObject({
      amount: '2',
    });
  });
  it('refuses a different positional recipient', () => {
    const other = '0xde709f2102306220921060314715629080e2fb77';
    expect(shiftForContact(bob, other, '2', undefined)).toEqual({
      ok: false,
      error: `Two recipients: -c bob and ${other}. Use one of them.`,
    });
    expect(shiftForContact(bob, 'alice', '2', 'cusdc')).toMatchObject({ ok: false });
  });
});

describe('send -c with positionals', () => {
  it('takes the amount and token from the positionals', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    seedToken('sepolia', KNOWN_ADDRESS);
    addAddress('bob', '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF');
    // Token "cxyz" is reached as the token, not misread as the amount.
    expect(await runSend('-c', 'bob', '2', 'cxyz')).toMatch(/No tracked token called "cxyz"/);
    logSpy.mockRestore();
    expect(await runSend('-c', 'bob', OTHER_ADDRESS, '2')).toMatch(/Two recipients: -c bob and/);
  });
});

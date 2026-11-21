import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
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
      /Invalid recipient address/,
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
    const out = await runSend();
    expect(out).toMatch(/Zama API key/);
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

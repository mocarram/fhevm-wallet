import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { saveWalletKeystore } from '../../src/storage/WalletStore.js';
import { getEnvVar } from '../../src/storage/paths.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const FAKE_KEYSTORE = JSON.stringify({ version: 3, id: 'fake' });
const FAKE_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

let logSpy: ReturnType<typeof vi.spyOn>;

function captureLog(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

async function runProgram(...argv: string[]): Promise<string> {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(['node', 'fhevm-wallet', ...argv]);
  return captureLog();
}

beforeEach(() => {
  wipeTestDataDir();
});

afterEach(() => {
  logSpy?.mockRestore();
});

describe('createProgram', () => {
  it('exposes the expected top-level commands', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'balance',
        'config',
        'history',
        'interactive',
        'send',
        'token',
        'wallet',
      ]),
    );
  });

  it('renders --help without throwing', () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(() => program.parse(['node', 'fhevm-wallet', '--help'])).toThrow(
      expect.objectContaining({ code: 'commander.helpDisplayed' }),
    );
  });

  it('config --show prints current configuration', async () => {
    const out = await runProgram('config', '--show');
    expect(out).toContain('Current configuration');
    expect(out).toContain('Default network');
  });

  it('config --network sepolia persists default network', async () => {
    await runProgram('config', '--network', 'sepolia');
    const out = await runProgram('config', '--show');
    expect(out).toMatch(/Default network:\s+sepolia/);
  });

  it('config --etherscan-key writes to env file', async () => {
    await runProgram('config', '--etherscan-key', 'esk-12345678');
    expect(getEnvVar('ETHERSCAN_API_KEY')).toBe('esk-12345678');
  });
});

describe('wallet command', () => {
  it('lists "no wallets" message when empty', async () => {
    const out = await runProgram('wallet', 'list');
    expect(out).toContain('No wallets found');
  });

  it('lists known wallets and marks the default', async () => {
    saveWalletKeystore('main', FAKE_KEYSTORE, FAKE_ADDRESS);
    saveWalletKeystore('alt', FAKE_KEYSTORE, FAKE_ADDRESS);
    await runProgram('config', '--network', 'sepolia');
    await runProgram('wallet', 'set-default', 'main');

    const out = await runProgram('wallet', 'list');
    expect(out).toContain('main');
    expect(out).toContain('alt');
  });

  it('removes a wallet with --force and surfaces "not found" otherwise', async () => {
    saveWalletKeystore('victim', FAKE_KEYSTORE, FAKE_ADDRESS);

    const removeOut = await runProgram('wallet', 'remove', 'victim', '--force');
    expect(removeOut).toMatch(/removed/i);

    const missingOut = await runProgram('wallet', 'remove', 'ghost', '--force');
    expect(missingOut).toMatch(/not found/i);
  });

  it('rejects export against an unknown wallet without prompting', async () => {
    const out = await runProgram('wallet', 'export', 'ghost');
    expect(out).toMatch(/not found/i);
  });
});

describe('token command', () => {
  it('reports an empty registry', async () => {
    const out = await runProgram('token', 'list', '--network', 'sepolia');
    expect(out).toContain('No tokens tracked');
  });

  it('global --network with an invalid value rejects via process.exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(runProgram('--network', 'goerli', 'token', 'list')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects token remove with an invalid address', async () => {
    const out = await runProgram(
      'token',
      'remove',
      'not-an-address',
      '--network',
      'sepolia',
      '--force',
    );
    expect(out).toMatch(/Invalid Ethereum address/);
  });

  it('reports "not found" when removing an unknown token (force)', async () => {
    const out = await runProgram(
      'token',
      'remove',
      FAKE_ADDRESS,
      '--network',
      'sepolia',
      '--force',
    );
    expect(out).toMatch(/not found/i);
  });
});

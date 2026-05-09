import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { saveConfig } from '../../src/storage/ConfigStore.js';
import { saveWalletKeystore } from '../../src/storage/WalletStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const FAKE_KEYSTORE = JSON.stringify({ version: 3, id: 'fake' });
const FAKE_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

let logSpy: ReturnType<typeof vi.spyOn>;

async function runBalance(...args: string[]): Promise<string> {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(['node', 'fhevm-wallet', 'balance', ...args]);
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  wipeTestDataDir();
  delete process.env.ZAMA_MAINNET_API_KEY;
});

afterEach(() => {
  logSpy?.mockRestore();
});

describe('balance command early exits', () => {
  it('global -n with an invalid value rejects via process.exit(1)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(runBalance('--network', 'goerli')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects mainnet without ZAMA_MAINNET_API_KEY', async () => {
    saveConfig({ defaultNetwork: 'mainnet' });
    saveWalletKeystore('main', FAKE_KEYSTORE, FAKE_ADDRESS);
    const out = await runBalance('--wallet', 'main');
    expect(out).toMatch(/Zama API key/);
  });

  it('rejects an unknown wallet name without prompting', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runBalance('--wallet', 'ghost');
    expect(out).toMatch(/Wallet "ghost" not found/);
  });

  it('reports "No wallets found" when registry is empty and no -w given', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runBalance();
    expect(out).toMatch(/No wallets found/);
  });
});

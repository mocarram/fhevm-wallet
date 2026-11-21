import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { saveConfig, setDefaultWallet } from '../../src/storage/ConfigStore.js';
import { saveWalletKeystore } from '../../src/storage/WalletStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const KNOWN_ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

let logSpy: ReturnType<typeof vi.spyOn>;

async function runHistory(...args: string[]): Promise<string> {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(['node', 'fhevm-wallet', 'history', ...args]);
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  wipeTestDataDir();
  delete process.env.ETHERSCAN_API_KEY;
});

afterEach(() => {
  logSpy?.mockRestore();
});

describe('history command early exits', () => {
  it('needs --address when there is no default wallet', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runHistory();
    expect(out).toMatch(/Pass a wallet address with --address/);
  });

  it('falls back to the default wallet without --address', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    saveWalletKeystore('alice', '{}', KNOWN_ADDRESS);
    setDefaultWallet('alice');
    // Gets past the address step to the token check.
    const out = await runHistory();
    expect(out).toMatch(/No tokens tracked on sepolia/);
  });

  it('rejects an invalid wallet address', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runHistory('--address', 'not-an-address');
    expect(out).toMatch(/Invalid wallet address/);
  });

  it('reports "No tokens tracked" when registry is empty', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runHistory('--address', KNOWN_ADDRESS);
    expect(out).toMatch(/No tokens tracked on sepolia/);
  });
});

describe('history type column (V5)', () => {
  it('uses no emoji: wrap mints and unwrap burns are words', async () => {
    const { getTypeIcon } = await import('../../src/cli/commands/history.js');
    const plainText = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(plainText(getTypeIcon('burn'))).toBe('burn');
    expect(plainText(getTypeIcon('mint'))).toBe('mint');
    for (const t of ['mint', 'burn', 'eth', 'transfer']) {
      expect(plainText(getTypeIcon(t))).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { saveConfig } from '../../src/storage/ConfigStore.js';
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
  it('requires --address', async () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const out = await runHistory();
    expect(out).toMatch(/specify a wallet address with --address/);
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

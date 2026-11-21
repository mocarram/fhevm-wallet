import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stub backend: the disclose command must stop before it needs anything else.
const backend = {
  kind: 'real',
  readinessProblem: () => null,
  findTransferHandle: vi.fn(async () => null),
  discloseStage: vi.fn(async () => 'private'),
  prepareDiscloseRequest: vi.fn(),
};
vi.mock('../../src/core/backend/select.js', () => ({ createBackend: () => backend }));

const { createProgram } = await import('../../src/cli/index.js');
const { prompts } = await import('../../src/cli/utils/prompts.js');
const { saveWalletKeystore } = await import('../../src/storage/WalletStore.js');
const { setDefaultWallet } = await import('../../src/storage/ConfigStore.js');
const { addTokenWithInfo } = await import('../../src/core/token/TokenRegistry.js');
const { wipeTestDataDir } = await import('../helpers/dataDir.js');

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const TOKEN = '0xde709f2102306220921060314715629080E2fB77';
const RAW = '0x' + 'ab'.repeat(32);

async function run(...argv: string[]): Promise<string> {
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
    out += a.join(' ') + '\n';
  });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out += String(c);
    return true;
  });
  try {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync(['node', 'fhevm-wallet', 'disclose', ...argv]);
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
  return out;
}

beforeEach(() => {
  wipeTestDataDir();
  process.exitCode = undefined;
  saveWalletKeystore('alice', '{}', ADDRESS);
  setDefaultWallet('alice');
  addTokenWithInfo({ address: TOKEN, name: 'Tok', symbol: 'TOK', decimals: 6 }, 'sepolia');
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('fhew disclose with a raw handle', () => {
  // Regression: a raw handle could be an earlier balance of this wallet, and disclosing
  // it would publish that balance for good.
  it('refuses a handle that is no known transfer under --yes', async () => {
    const out = await run(
      RAW,
      '--token',
      TOKEN,
      '-n',
      'sepolia',
      '--yes',
      '--password-stdin',
      '--json',
    );
    expect(JSON.parse(out).error.code).toBe('DISCLOSE_UNKNOWN_HANDLE');
    expect(backend.prepareDiscloseRequest).not.toHaveBeenCalled();
  });

  it('at a terminal, needs the word typed out', async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const input = vi.spyOn(prompts, 'input').mockResolvedValue('yes');
    try {
      const out = await run(RAW, '--token', TOKEN, '-n', 'sepolia');
      expect(input).toHaveBeenCalledTimes(1);
      expect(String(input.mock.calls[0][0].message)).toMatch(/Type disclose/);
      expect(out).toMatch(/could be an earlier balance/);
      expect(process.exitCode).toBe(1);
      expect(backend.prepareDiscloseRequest).not.toHaveBeenCalled();
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});

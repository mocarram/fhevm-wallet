import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { toJsonValue } from '../../src/cli/utils/json.js';
import { saveWalletKeystore } from '../../src/storage/WalletStore.js';
import { setDefaultWallet } from '../../src/storage/ConfigStore.js';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const TOKEN = '0xde709f2102306220921060314715629080E2fB77';

/** Run the program and return what it wrote to stdout (console.log is stdout too). */
async function stdoutOf(...argv: string[]): Promise<string> {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
    out += a.join(' ') + '\n';
  });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync(['node', 'fhevm-wallet', ...argv]);
  } finally {
    write.mockRestore();
    log.mockRestore();
    err.mockRestore();
  }
  return out;
}

beforeEach(() => {
  wipeTestDataDir();
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  delete process.env.SEPOLIA_RPC_URL;
  delete process.env.ETHERSCAN_API_KEY;
});

describe('toJsonValue', () => {
  it('turns bigints into strings and redacts strings, dropping undefined', () => {
    process.env.ETHERSCAN_API_KEY = 'ETHERSCANKEY123456';
    expect(
      toJsonValue({ wei: 10n ** 20n, note: 'key ETHERSCANKEY123456', gone: undefined, n: [1n] }),
    ).toEqual({ wei: '100000000000000000000', note: 'key [redacted]', n: ['1'] });
  });
});

describe('--json output', () => {
  it('wallet list', async () => {
    saveWalletKeystore('alice', '{}', ADDRESS);
    setDefaultWallet('alice');
    const doc = JSON.parse(await stdoutOf('wallet', 'list', '--json'));
    expect(doc).toEqual({
      wallets: [{ name: 'alice', address: ADDRESS, createdAt: expect.any(String), isDefault: true }],
    });
  });

  it('token list, also when empty, and an invalid network as a JSON error', async () => {
    expect(JSON.parse(await stdoutOf('token', 'list', '--json'))).toEqual({ tokens: [] });
    addTokenWithInfo({ address: TOKEN, name: 'Conf USD', symbol: 'cUSD', decimals: 6 }, 'sepolia');
    const doc = JSON.parse(await stdoutOf('token', 'list', '--json'));
    expect(doc.tokens[0]).toMatchObject({ address: TOKEN, symbol: 'cUSD', network: 'sepolia' });
    let code: unknown;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c: unknown) => {
      code = c;
      throw new Error('exit');
    }) as never);
    try {
      await stdoutOf('token', 'list', '--json', '-n', 'nope').catch(() => '');
    } finally {
      exit.mockRestore();
    }
    expect(code).toBe(1);
  });

  it('config --show masks RPC URLs and keys like the text output', async () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/v3/SECRETKEY1234567890';
    process.env.ETHERSCAN_API_KEY = 'ETHERSCANKEY123456';
    const out = await stdoutOf('config', '--show', '--json');
    expect(out).not.toContain('SECRETKEY1234567890');
    expect(out).not.toContain('ETHERSCANKEY123456');
    const doc = JSON.parse(out);
    expect(doc.rpc.sepolia).toEqual({ url: 'https://rpc.example/…', custom: true, source: 'environment' });
    expect(doc.rpc.mainnet.custom).toBe(false);
    expect(doc.apiKeys.etherscan).toEqual({ set: true, last4: '3456', source: 'environment' });
    expect(doc.apiKeys.zama).toEqual({ set: false });
  });

  it('send refuses prompts with --json', async () => {
    const doc = JSON.parse(await stdoutOf('send', 'bob', '1', '--json'));
    expect(doc.error.code).toBe('PROMPT_NOT_ALLOWED');
    expect(process.exitCode).toBe(1);
  });

  it('balance needs --password-stdin with --json; history validates the address', async () => {
    saveWalletKeystore('alice', '{}', ADDRESS);
    const bal = JSON.parse(await stdoutOf('balance', '--json', '-w', 'alice'));
    expect(bal.error.code).toBe('PASSWORD_STDIN_REQUIRED');
    const hist = JSON.parse(await stdoutOf('history', '--json', '-a', 'nope'));
    expect(hist.error.code).toBe('INVALID_ADDRESS');
  });
});

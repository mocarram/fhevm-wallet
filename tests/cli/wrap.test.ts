/**
 * `fhew wrap` / `fhew unwrap` against the MockBackend (no network): exact amounts,
 * refusals before signing, JSON output and the pending-unwrap commands.
 */
import { Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../../src/core/backend/MockBackend.js';

let backend: MockBackend;
let password = 'pw';
vi.mock('../../src/core/backend/select.js', () => ({ createBackend: () => backend }));
vi.mock('../../src/cli/utils/passwordInput.js', async (orig) => ({
  ...(await orig<typeof import('../../src/cli/utils/passwordInput.js')>()),
  walletPassword: async () => password,
}));

const { createProgram } = await import('../../src/cli/index.js');
const { saveWalletKeystore } = await import('../../src/storage/WalletStore.js');
const { setDefaultWallet } = await import('../../src/storage/ConfigStore.js');
const { addTokenWithInfo } = await import('../../src/core/token/TokenRegistry.js');
const { listUnwraps } = await import('../../src/storage/UnwrapStore.js');
const { listTransactions } = await import('../../src/storage/TransactionStore.js');
const { wipeTestDataDir } = await import('../helpers/dataDir.js');

const wallet = Wallet.createRandom();
const keystore = wallet.encryptSync('pw', { scrypt: { N: 1024 } } as never);
const instant = { latencyMs: 0, confirmMs: 0, sleep: async () => {} };

async function run(...argv: string[]) {
  let out = '';
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out += String(c);
    return true;
  });
  const errWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync(['node', 'fhevm-wallet', ...argv, '--json']);
  } finally {
    log.mockRestore();
    err.mockRestore();
    write.mockRestore();
    errWrite.mockRestore();
  }
  return JSON.parse(out) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const yes = ['--yes', '--password-stdin', '-n', 'sepolia'];

beforeEach(() => {
  wipeTestDataDir();
  password = 'pw';
  process.exitCode = undefined;
  backend = new MockBackend(instant);
  saveWalletKeystore('alice', keystore, wallet.address);
  setDefaultWallet('alice');
  for (const t of backend.catalogue('sepolia')) addTokenWithInfo(t, 'sepolia');
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('fhew wrap', () => {
  it('refuses a wrap that would mint 0 before unlocking or signing', async () => {
    const spy = vi.spyOn(backend, 'prepareWrap');
    const doc = await run('wrap', '0.0000001', 'cdai', ...yes);
    expect(doc.error.code).toBe('INVALID_AMOUNT');
    expect(doc.error.message).toMatch(/That wraps to 0 cDAI: the smallest amount is 0.000001 DAI/);
    expect(spy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('wraps max (ERC-20 units), approves exactly, keeps the dust and reports the balance', async () => {
    const doc = await run('wrap', 'max', 'dai', ...yes);
    expect(doc).toMatchObject({
      status: 'wrapped',
      mock: true,
      token: { symbol: 'cDAI' },
      underlying: { symbol: 'DAI', decimals: 18 },
      amount: { baseUnits: '1000000000000000000000', formatted: '1,000' },
      wrapped: { baseUnits: '1000000000', formatted: '1,000' },
      dust: { baseUnits: '123456789000', formatted: '0.000000123456789' },
      balanceCheck: 'moved',
      balanceBefore: '80500000',
      balanceAfter: '1080500000',
    });
    expect(doc.approveTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(doc.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('refuses a token that is not a wrapper and an unknown token', async () => {
    const gift = '0x' + '12'.repeat(20);
    addTokenWithInfo({ address: gift, name: 'Gift', symbol: 'cGIFT', decimals: 6 }, 'sepolia');
    expect((await run('wrap', '1', 'cgift', ...yes)).error.code).toBe('NOT_A_WRAPPER');
    expect((await run('wrap', '1', 'nope', ...yes)).error.code).toBe('TOKEN_NOT_TRACKED');
    expect((await run('wrap', '1', ...yes)).error.code).toBe('TOKEN_AMBIGUOUS');
  });

  it('names the wallet as an object and records the wrap in history', async () => {
    const doc = await run('wrap', '5', 'cusdc', ...yes);
    expect(doc.wallet).toEqual({ name: 'alice', address: wallet.address });
    const mint = listTransactions({ walletAddress: wallet.address, network: 'sepolia' }).find(
      (t) => t.txHash === doc.txHash,
    );
    expect(mint).toMatchObject({ type: 'mint', tokenSymbol: 'cUSDC', amount: '5' });
    expect(mint!.blockNumber).toBeGreaterThan(0);
  });

  it('takes the token from -t and refuses two different tokens', async () => {
    expect((await run('wrap', '1', '-t', 'cusdc', ...yes)).status).toBe('wrapped');
    expect((await run('wrap', '1', 'cusdc', '-t', 'cdai', ...yes)).error.code).toBe(
      'CONFLICTING_TOKENS',
    );
  });

  it('says INVALID_AMOUNT and INSUFFICIENT_BALANCE like fhew send', async () => {
    expect((await run('wrap', 'lots', 'cusdc', ...yes)).error.code).toBe('INVALID_AMOUNT');
    expect((await run('wrap', '1000000', 'cusdc', ...yes)).error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('keeps the Mainnet guard', async () => {
    const doc = await run('wrap', '1', 'cusdc', '--yes', '--password-stdin', '-n', 'mainnet');
    expect(doc.error.code).toBe('MAINNET_NOT_CONFIRMED');
  });

  it('needs --yes and --password-stdin with --json', async () => {
    expect((await run('wrap', '1', 'cusdc')).error.code).toBe('PROMPT_NOT_ALLOWED');
  });
});

describe('fhew unwrap', () => {
  it('requests and finishes in one run, recording the unwrap', async () => {
    const doc = await run('unwrap', '10', 'cusdc', ...yes);
    expect(doc).toMatchObject({
      status: 'finished',
      state: 'finished',
      amount: { baseUnits: '10000000' },
      finishedBy: 'wallet',
    });
    expect(doc.finalizeTxHash).toMatch(/^0x/);
    expect(listUnwraps({ open: true })).toEqual([]);
  });

  it('refuses a mistyped amount before unlocking', async () => {
    const unlock = vi.spyOn(backend, 'newDecryptSession');
    expect((await run('unwrap', '1o', 'cusdc', ...yes)).error.code).toBe('INVALID_AMOUNT');
    expect(unlock).not.toHaveBeenCalled();
  });

  it('records the request as a burn; --list gives mock and the wallet object', async () => {
    await run('unwrap', '10', 'cusdc', ...yes);
    const burn = listTransactions({ walletAddress: wallet.address, network: 'sepolia' }).find(
      (t) => t.type === 'burn',
    );
    expect(burn).toMatchObject({ tokenSymbol: 'cUSDC', amount: '10' });
    const list = await run('unwrap', '--list', '--all', '-n', 'sepolia');
    // mock comes from FHEW_BACKEND (not set here: the test injects the backend).
    expect(list).toMatchObject({
      mock: false,
      wallet: { name: 'alice', address: wallet.address },
    });
  });

  it('refuses more than the decrypted balance (a burn above it burns 0)', async () => {
    const spy = vi.spyOn(backend, 'prepareUnwrap');
    const doc = await run('unwrap', '1251', 'cusdc', ...yes);
    expect(doc.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(doc.error.message).toMatch(/burn 0/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops at "pending" when not decryptable yet; --resume finishes it later', async () => {
    backend = new MockBackend({ ...instant, fail: 'public-pending' });
    const doc = await run('unwrap', '5', 'cusdc', ...yes);
    expect(doc).toMatchObject({ status: 'pending', state: 'requested' });
    const list = await run('unwrap', '--list', '-n', 'sepolia');
    expect(list.unwraps).toHaveLength(1);

    backend = new MockBackend(instant); // a later run, decryption ready
    const resumed = await run('unwrap', '--resume', ...yes);
    expect(resumed.results).toHaveLength(1);
    expect(resumed.results[0]).toMatchObject({ status: 'finished', state: 'finished' });
    // Running it again sends nothing.
    const again = await run('unwrap', '--resume', ...yes);
    expect(again.results).toEqual([]);
  });

  it('never sends a second request while one is unconfirmed', async () => {
    backend = new MockBackend({ ...instant, fail: 'unconfirmed' });
    const first = await run('unwrap', '1', 'cusdc', ...yes);
    expect(first.error.code).toBe('SENT_UNCONFIRMED');
    expect(first.error.txHash).toMatch(/^0x/);
    const spy = vi.spyOn(backend, 'prepareUnwrap');
    const second = await run('unwrap', '1', 'cusdc', ...yes);
    expect(second.error.code).toBe('UNWRAP_UNCONFIRMED');
    expect(spy).not.toHaveBeenCalled();
    // Still unconfirmed: resume waits and sends nothing.
    const waiting = await run('unwrap', '--resume', ...yes);
    expect(waiting.results[0]).toMatchObject({ status: 'waiting', state: 'signed' });
    // A forget is refused while the network might still mine it? Here the node does not
    // know it (dropped), so it may be removed.
    const forgot = await run('unwrap', '--forget', first.error.txHash.slice(0, 14), '--yes');
    expect(forgot.removed.id).toBe(first.error.txHash);
  });

  it('refuses to forget an unwrap that is waiting for step 2', async () => {
    backend = new MockBackend({ ...instant, fail: 'public-pending' });
    const doc = await run('unwrap', '5', 'cusdc', ...yes);
    const r = await run('unwrap', '--forget', doc.id, '--yes');
    expect(r.error.code).toBe('UNWRAP_STILL_OPEN');
    expect(listUnwraps({ open: true })).toHaveLength(1);
  });

  it('--resume --json with a wrong password prints exactly one error document', async () => {
    backend = new MockBackend({ ...instant, fail: 'public-pending' });
    await run('unwrap', '5', 'cusdc', ...yes);
    backend = new MockBackend(instant);
    password = 'wrong';
    const spy = vi.spyOn(backend, 'prepareFinalizeUnwrap');
    // run() parses stdout as one JSON document: a second one would make it throw.
    const doc = await run('unwrap', '--resume', ...yes);
    expect(doc.error.code).toBe('WRONG_PASSWORD');
    expect(doc.results).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(listUnwraps({ open: true })).toHaveLength(1);
  });
});

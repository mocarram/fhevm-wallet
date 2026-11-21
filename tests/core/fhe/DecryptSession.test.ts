import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  chunkByBits,
  DecryptSession,
  decryptDaysFromEnv,
  handleBits,
  normaliseHandle,
  type DecryptAuthority,
} from '../../../src/core/fhe/DecryptSession.js';
import { quietSdk, capturedSdkLines } from '../../../src/core/fhe/sdkConsole.js';

const signer = Wallet.createRandom();
const handle = (n: number, type = '05') => '0x' + n.toString(16).padStart(60, '0') + type + '00';
const token = (n: number) => '0x' + n.toString(16).padStart(40, '0');

function stubAuthority() {
  const authority = {
    authorize: vi.fn(async (_s, contracts: string[], startTimestamp: number, durationDays) => ({
      publicKey: '0xpub',
      privateKey: '0xpriv',
      signature: '0xsig',
      contracts,
      userAddress: signer.address,
      startTimestamp,
      durationDays,
    })),
    userDecrypt: vi.fn(async (_auth, pairs: Array<{ handle: string }>) =>
      Object.fromEntries(
        pairs.map((p) => [p.handle, BigInt(parseInt(p.handle.slice(50, 62), 16))]),
      ),
    ),
  } satisfies DecryptAuthority;
  return authority;
}

describe('DecryptSession', () => {
  it('signs once for N tokens and decrypts them in one request', async () => {
    const a = stubAuthority();
    const s = new DecryptSession(signer, 'sepolia', a);
    const tokens = [1, 2, 3, 4, 5].map(token);
    const pairs = tokens.map((t, i) => ({ handle: handle(i + 1), contractAddress: t }));
    const out = await s.decrypt(pairs, tokens);
    expect(a.authorize).toHaveBeenCalledTimes(1);
    expect(s.signatures).toBe(1);
    expect(a.userDecrypt).toHaveBeenCalledTimes(1);
    expect(out.values.get(normaliseHandle(handle(3)))).toBe(3n);
    // A second refresh reuses the signature.
    await s.decrypt(pairs.slice(0, 2), tokens);
    expect(s.signatures).toBe(1);
  });

  it('re-signs when the token set grows, and covers the old tokens too', async () => {
    const a = stubAuthority();
    const s = new DecryptSession(signer, 'sepolia', a);
    await s.decrypt([{ handle: handle(1), contractAddress: token(1) }], [token(1)]);
    await s.decrypt([{ handle: handle(2), contractAddress: token(2) }], [token(1), token(2)]);
    expect(s.signatures).toBe(2);
    expect(a.authorize.mock.calls[1][1]).toEqual([token(1), token(2)]);
    await s.decrypt([{ handle: handle(1), contractAddress: token(1) }], [token(1)]);
    expect(s.signatures).toBe(2);
  });

  it('re-signs shortly before the signature expires', async () => {
    const a = stubAuthority();
    let now = 1_700_000_000_000;
    const s = new DecryptSession(signer, 'sepolia', a, { durationDays: 1, now: () => now });
    await s.ensureSigned([token(1)]);
    now += 23 * 3600_000;
    await s.ensureSigned([token(1)]);
    expect(s.signatures).toBe(1);
    now += 55 * 60_000; // 5 minutes left: inside the margin
    await s.ensureSigned([token(1)]);
    expect(s.signatures).toBe(2);
  });

  it('respects the SDK limits: 10 contracts per signature, 2048 bits per request', async () => {
    const a = stubAuthority();
    const s = new DecryptSession(signer, 'sepolia', a);
    const tokens = Array.from({ length: 12 }, (_, i) => token(i + 1));
    // 40 euint64 handles on the first token: 2 requests (32 + 8).
    const pairs = Array.from({ length: 40 }, (_, i) => ({
      handle: handle(i + 1),
      contractAddress: tokens[0],
    }));
    pairs.push({ handle: handle(99), contractAddress: tokens[11] });
    const out = await s.decrypt(pairs, tokens);
    expect(s.signatures).toBe(2);
    expect(a.authorize.mock.calls.map((c) => c[1].length)).toEqual([10, 2]);
    expect(a.userDecrypt).toHaveBeenCalledTimes(3);
    expect(out.values.size).toBe(41);
  });

  it('records a failed request per handle and keeps the others', async () => {
    const a = stubAuthority();
    a.userDecrypt.mockRejectedValueOnce(new Error('relayer busy'));
    const s = new DecryptSession(signer, 'sepolia', a);
    const pairs = Array.from({ length: 33 }, (_, i) => ({
      handle: handle(i + 1),
      contractAddress: token(1),
    }));
    const out = await s.decrypt(pairs, [token(1)]);
    expect(out.errors.size).toBe(32);
    expect(out.values.size).toBe(1);
  });

  it('clear() drops the keypair and signature and refuses further use', async () => {
    const a = stubAuthority();
    const s = new DecryptSession(signer, 'sepolia', a);
    await s.ensureSigned([token(1)]);
    s.clear();
    expect(s.active).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/0xpriv|0xsig/);
    await expect(
      s.decrypt([{ handle: handle(1), contractAddress: token(1) }], [token(1)]),
    ).rejects.toThrow(/locked/);
  });

  it('counts bits by handle type and chunks by them', () => {
    expect(handleBits(handle(1, '05'))).toBe(64);
    expect(handleBits(handle(1, '08'))).toBe(256);
    const pairs = Array.from({ length: 9 }, (_, i) => ({
      handle: handle(i, '08'),
      contractAddress: token(1),
    }));
    expect(chunkByBits(pairs).map((c) => c.length)).toEqual([8, 1]);
  });

  it('reads FHEW_DECRYPT_DAYS within 1-365', () => {
    expect(decryptDaysFromEnv({})).toBe(1);
    expect(decryptDaysFromEnv({ FHEW_DECRYPT_DAYS: '7' })).toBe(7);
    expect(decryptDaysFromEnv({ FHEW_DECRYPT_DAYS: '400' })).toBe(1);
  });
});

describe('quietSdk', () => {
  it('captures SDK console output instead of printing it', async () => {
    const write = vi.spyOn(process.stdout, 'write');
    const original = console.warn;
    await quietSdk(async () => {
      console.warn('`createInstance` is deprecated. Use the `@zama-fhe/sdk` package instead.');
      console.log('TFHE module already initialized');
    });
    expect(console.warn).toBe(original);
    expect(write).not.toHaveBeenCalled();
    expect(capturedSdkLines().join('\n')).toMatch(/deprecated/);
    write.mockRestore();
  });
});

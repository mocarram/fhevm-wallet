import { describe, expect, it } from 'vitest';
import { ERC7984_INTERFACE } from '../../../src/core/token/TokenService.js';
import {
  DecryptionFailedError,
  isEmptyRevert,
  isNoContractAnswer,
  WalletTxError,
  formatTxError,
  sentButUnconfirmed,
  translateTxError,
} from '../../../src/core/token/txErrors.js';
import { WrongChainError } from '../../../src/core/network/ProviderFactory.js';
import { TimeoutError } from '../../../src/utils/timeout.js';

/** Build an object shaped like an ethers v6 error. */
function ethersError(fields: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), fields);
}

describe('translateTxError', () => {
  it('maps missing revert data during estimateGas to NOT_ERC7984', () => {
    const err = translateTxError(
      ethersError(
        { code: 'CALL_EXCEPTION', action: 'estimateGas', data: null },
        'missing revert data (action="estimateGas", data=null, reason=null)',
      ),
    );
    expect(err.code).toBe('NOT_ERC7984');
    expect(err.message).toMatch(/rejected the send when it was simulated/);
    expect(err.raw).toMatch(/missing revert data/);
  });

  it('maps INSUFFICIENT_FUNDS and node wording to INSUFFICIENT_GAS_FUNDS', () => {
    expect(translateTxError(ethersError({ code: 'INSUFFICIENT_FUNDS' })).code).toBe(
      'INSUFFICIENT_GAS_FUNDS',
    );
    expect(translateTxError(new Error('insufficient funds for gas * price + value')).code).toBe(
      'INSUFFICIENT_GAS_FUNDS',
    );
  });

  it('maps decoded ERC-7984 custom errors', () => {
    const err = translateTxError(
      ethersError({ code: 'CALL_EXCEPTION', revert: { name: 'ERC7984InvalidReceiver' } }),
    );
    expect(err.code).toBe('INVALID_RECEIVER');
  });

  it('decodes custom-error data that estimateGas leaves undecoded', () => {
    // Real shape: ethers estimateGas sets data to the encoded error and revert to null.
    const data = ERC7984_INTERFACE.encodeErrorResult('ERC7984ZeroBalance', [
      '0x000000000000000000000000000000000000dEaD',
    ]);
    const shaped = ethersError({
      code: 'CALL_EXCEPTION',
      action: 'estimateGas',
      data,
      revert: null,
    });
    expect(translateTxError(shaped).code).toBe('CONTRACT_REJECTED'); // without the interface
    const err = translateTxError(shaped, { iface: ERC7984_INTERFACE });
    expect(err.message).toMatch(/no balance of that token/);
  });

  it('strips control characters from contract-supplied reasons', () => {
    const err = translateTxError(
      ethersError({ code: 'CALL_EXCEPTION', reason: 'paused\u001b[31m now' }),
    );
    expect(err.likelyCause).not.toMatch(/\u001b/);
    expect(err.likelyCause).toMatch(/unverified/);
  });

  it('masks API keys from RPC URLs in raw details', () => {
    const err = translateTxError(
      new Error('request failed info={"requestUrl":"https://x.example/v3/abcdef0123456789abcdef"}'),
    );
    expect(err.raw).not.toMatch(/abcdef0123456789abcdef/);
    expect(err.raw).toContain('https://x.example/…');
  });

  it('maps network failures to RPC_UNAVAILABLE', () => {
    expect(translateTxError(ethersError({ code: 'TIMEOUT' })).code).toBe('RPC_UNAVAILABLE');
    expect(translateTxError(new TypeError('fetch failed')).code).toBe('RPC_UNAVAILABLE');
  });

  it('maps TRANSACTION_REPLACED to TX_REPLACED instead of UNKNOWN', () => {
    // Real ethers shape: `hash` is the REPLACEMENT's hash, not ours.
    const err = translateTxError(
      ethersError({
        code: 'TRANSACTION_REPLACED',
        reason: 'repriced',
        hash: '0xaa',
        replacement: { hash: '0xaa' },
        receipt: { hash: '0xaa', status: 1 },
      }),
    );
    expect(err.code).toBe('TX_REPLACED');
    expect(err.replacementHash).toBe('0xaa');
    // Without the caller's hash we don't know the original; never mislabel the replacement.
    expect(err.txHash).toBeUndefined();
  });

  it('maps a wrong-chain RPC to WRONG_CHAIN', () => {
    const err = translateTxError(new WrongChainError(1n, 11155111n));
    expect(err.code).toBe('WRONG_CHAIN');
    expect(err.likelyCause).toMatch(/chain 1\b/);
  });

  it('gives a relayer timeout its own wording, not "check your RPC"', () => {
    const err = translateTxError(new TimeoutError('Encrypting the amount', 1000));
    expect(err.code).toBe('RELAYER_TIMEOUT');
    expect(err.message).toMatch(/Zama relayer/);
    expect(err.likelyCause).toMatch(/Encrypting the amount/);
    expect(err.hint).not.toMatch(/RPC/);
  });

  it('maps nonce problems to NONCE_CONFLICT', () => {
    expect(translateTxError(ethersError({ code: 'NONCE_EXPIRED' })).code).toBe('NONCE_CONFLICT');
  });

  it('keeps the contract reason for other reverts', () => {
    const err = translateTxError(ethersError({ code: 'CALL_EXCEPTION', reason: 'paused' }));
    expect(err.code).toBe('CONTRACT_REJECTED');
    expect(err.likelyCause).toMatch(/paused/);
  });

  it('passes WalletTxError through unchanged and falls back to UNKNOWN', () => {
    const original = new WalletTxError('UNKNOWN', 'x', 'y', 'z');
    expect(translateTxError(original)).toBe(original);
    expect(translateTxError('weird').code).toBe('UNKNOWN');
  });
});

describe('sentButUnconfirmed', () => {
  const HASH = '0x' + '11'.repeat(32);
  const REPL = '0x' + '22'.repeat(32);
  const LINK = `https://sepolia.etherscan.io/tx/${HASH}`;

  it('treats "nonce too low" after broadcast as possibly sent (gateway retries)', () => {
    const err = sentButUnconfirmed(
      ethersError({ code: 'NONCE_EXPIRED' }, 'nonce too low'),
      HASH,
      LINK,
    );
    expect(err.code).toBe('SENT_UNCONFIRMED');
    expect(err.txHash).toBe(HASH);
    expect(err.message).toMatch(/may have been sent/);
    expect(err.hint).toBe(`Do not send again yet. Check ${LINK} first.`);
    expect(err.hint).not.toMatch(/try again/i);
  });

  it('only INSUFFICIENT_FUNDS and REPLACEMENT_UNDERPRICED count as definitely not sent', () => {
    const funds = sentButUnconfirmed(ethersError({ code: 'INSUFFICIENT_FUNDS' }), HASH, LINK);
    expect(funds.code).toBe('INSUFFICIENT_GAS_FUNDS');
    expect(funds.txHash).toBeUndefined();
    const under = sentButUnconfirmed(ethersError({ code: 'REPLACEMENT_UNDERPRICED' }), HASH, LINK);
    expect(under.code).toBe('NONCE_CONFLICT');
    expect(under.txHash).toBeUndefined();
    // Uncoded text that merely mentions funds is not proof the node refused it.
    expect(sentButUnconfirmed(new Error('insufficient funds?'), HASH, LINK).code).toBe(
      'SENT_UNCONFIRMED',
    );
    for (const code of ['TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR']) {
      expect(sentButUnconfirmed(ethersError({ code }), HASH, LINK).code).toBe('SENT_UNCONFIRMED');
    }
  });

  it('keeps a mined revert as TX_REVERTED with the hash', () => {
    const err = sentButUnconfirmed(
      ethersError({ code: 'CALL_EXCEPTION', action: 'sendTransaction', receipt: { hash: HASH } }),
      HASH,
      LINK,
    );
    expect(err).toMatchObject({ code: 'TX_REVERTED', txHash: HASH });
    expect(err.hint).toContain(LINK);
  });

  it.each([
    ['cancelled', /cancelled by another one/, /did not happen/],
    ['replaced', /replaced by another one/, /did not happen/],
    ['repriced', /different fee/, /most likely went through/],
  ])('maps TRANSACTION_REPLACED (%s) to TX_REPLACED', (reason, title, cause) => {
    const err = sentButUnconfirmed(
      // Real ethers shape: hash, replacement and receipt all describe the replacement.
      ethersError({
        code: 'TRANSACTION_REPLACED',
        reason,
        hash: REPL,
        replacement: { hash: REPL },
        receipt: { hash: REPL, status: 1 },
      }),
      HASH,
      LINK,
    );
    expect(err.code).toBe('TX_REPLACED');
    expect(err.message).toMatch(title);
    expect(err.likelyCause).toMatch(cause);
    expect(err.txHash).toBe(HASH);
    expect(err.replacementHash).toBe(REPL);
    expect(err.hint).toContain(`https://sepolia.etherscan.io/tx/${REPL}`);
    expect(formatTxError(err, false)).toContain(`Replaced by:  ${REPL}`);
  });

  it('TX_REPLACED without a replacement hash still links the original', () => {
    const err = sentButUnconfirmed(
      ethersError({ code: 'TRANSACTION_REPLACED', reason: 'replaced' }),
      HASH,
      LINK,
    );
    expect(err.code).toBe('TX_REPLACED');
    expect(err.txHash).toBe(HASH);
    expect(err.replacementHash).toBeUndefined();
    expect(err.hint).toContain(LINK);
  });

  it('a repriced replacement that reverted is not reported as "went through"', () => {
    const err = sentButUnconfirmed(
      ethersError({
        code: 'TRANSACTION_REPLACED',
        reason: 'repriced',
        hash: REPL,
        replacement: { hash: REPL },
        receipt: { hash: REPL, status: 0 },
      }),
      HASH,
      LINK,
    );
    expect(err.code).toBe('TX_REPLACED');
    expect(err.message).toMatch(/reverted/);
    expect(err.likelyCause).toMatch(/reverted on-chain/);
    expect(err.likelyCause).not.toMatch(/most likely went through/);
    expect(err.hint).not.toMatch(/Do not send again/);
    expect(err).toMatchObject({ txHash: HASH, replacementHash: REPL });
    expect(err.hint).toContain(`https://sepolia.etherscan.io/tx/${REPL}`);
  });
});

describe('formatTxError', () => {
  it('hides raw details unless asked', () => {
    const err = new WalletTxError('UNKNOWN', 'Title', 'Cause', 'Hint', 'RAW');
    expect(formatTxError(err, false)).not.toMatch(/RAW/);
    expect(formatTxError(err, false)).toMatch(/FHEW_DEBUG=1/);
    expect(formatTxError(err, true)).toMatch(/Technical details: RAW/);
  });
});

describe('sanitizeContractText', () => {
  it('removes bidi overrides and zero-width characters', async () => {
    const { sanitizeContractText } = await import('../../../src/core/token/txErrors.js');
    const out = sanitizeContractText('send to 0xabc‮dcba​ now');
    expect(out).not.toMatch(/[‮​]/);
  });
});

describe('relayer failures', () => {
  it('a relayer error that is not a timeout is RELAYER_UNAVAILABLE, not an RPC problem', () => {
    for (const err of [
      new Error("Relayer didn't response correctly. Bad JSON."),
      Object.assign(new Error('bad answer'), { code: 'RELAYER_FETCH_ERROR' }),
      new DecryptionFailedError(new Error('fetch failed')),
    ]) {
      const t = translateTxError(err);
      expect(t.code).toBe('RELAYER_UNAVAILABLE');
      expect(`${t.message} ${t.likelyCause} ${t.hint}`).toMatch(/relayer/i);
      expect(t.hint).not.toMatch(/check your rpc/i);
    }
  });

  it('a timed-out decrypt stays RELAYER_TIMEOUT', () => {
    const t = translateTxError(new DecryptionFailedError(new TimeoutError('Decrypting', 1000)));
    expect(t.code).toBe('RELAYER_TIMEOUT');
  });

  it('technical details strip terminal escapes', () => {
    const e = new WalletTxError('UNKNOWN', 'T', 'c', 'h', 'raw \u001b[2J text');
    expect(formatTxError(e, true)).not.toContain('\u001b');
  });
});

describe('WalletTxError raw details', () => {
  it('mask URLs to scheme and host and strip escapes', () => {
    const e = new WalletTxError(
      'UNKNOWN',
      'T',
      'c',
      'h',
      'failed https://rpc.example/qn/SOMETHINGLONG/?x=1 \u001b[31m',
    );
    expect(e.raw).toContain('https://rpc.example/…');
    expect(e.raw).not.toContain('SOMETHINGLONG');
    expect(e.raw).not.toContain('\u001b');
  });
});

describe('JSON-RPC errors from the endpoint itself', () => {
  /** What ethers throws for eth_call when the node answers {"error": {...}}. */
  const callError = (code: number, message: string) =>
    ethersError(
      { code: 'CALL_EXCEPTION', action: 'call', data: null, info: { error: { code, message } } },
      'missing revert data',
    );
  const coalesce = (code: number, message: string) =>
    ethersError({ code: 'UNKNOWN_ERROR', error: { code, message } }, 'could not coalesce error');

  it('a quota or rate-limit reply is RPC_RATE_LIMITED', () => {
    expect(translateTxError(callError(-32005, 'daily request count exceeded')).code).toBe(
      'RPC_RATE_LIMITED',
    );
    expect(translateTxError(coalesce(-32000, 'Too Many Requests')).code).toBe('RPC_RATE_LIMITED');
  });

  it('matches whole rate-limit phrases only', () => {
    for (const m of [
      'rate limit reached',
      'Rate-limited',
      'Too Many Requests',
      'quota used up',
      'HTTP 429',
      'error -32005',
      'request throttled',
    ]) {
      expect(translateTxError(coalesce(-32000, m)).code, m).toBe('RPC_RATE_LIMITED');
    }
    for (const m of [
      'exceeds block gas limit',
      'gas limit reached',
      'max fee exceeded',
      'over capacity soon',
    ]) {
      expect(translateTxError(coalesce(-32000, m)).code, m).not.toBe('RPC_RATE_LIMITED');
    }
  });

  it('an invalid key is RPC_AUTH', () => {
    expect(translateTxError(callError(-32000, 'invalid api key')).code).toBe('RPC_AUTH');
    expect(translateTxError(coalesce(-32001, 'Unauthorized')).code).toBe('RPC_AUTH');
  });

  it('anything else is RPC_ERROR with the redacted reason', () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/qn/QNSECRETTOKEN77aa88bb/';
    try {
      const t = translateTxError(
        coalesce(
          -32603,
          'internal failure /qn/QNSECRETTOKEN77aa88bb/?x=1 key=QNSECRETTOKEN77aa88bb',
        ),
      );
      expect(t.code).toBe('RPC_ERROR');
      expect(t.message).toMatch(/^The RPC endpoint returned an error: internal failure/);
      expect(t.message).not.toContain('QNSECRETTOKEN77aa88bb');
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
    }
  });

  it('a revert is still the contract talking, not the endpoint', () => {
    const t = translateTxError(callError(3, 'execution reverted'));
    expect(t.code).not.toMatch(/^RPC_/);
  });

  it('isNoContractAnswer only trusts BAD_DATA; isEmptyRevert excludes RPC errors', () => {
    expect(isNoContractAnswer(callError(-32005, 'limit'))).toBe(false);
    expect(isNoContractAnswer(ethersError({ code: 'BAD_DATA', value: '0x' }))).toBe(true);
    expect(isEmptyRevert(callError(-32005, 'limit'))).toBe(false);
    expect(isEmptyRevert(ethersError({ code: 'CALL_EXCEPTION', action: 'call', data: null }))).toBe(
      true,
    );
  });
});

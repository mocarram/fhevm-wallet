import { describe, expect, it } from 'vitest';
import { ERC7984_INTERFACE } from '../../../src/core/token/TokenService.js';
import {
  WalletTxError,
  formatTxError,
  translateTxError,
} from '../../../src/core/token/txErrors.js';

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
    expect(err.raw).toMatch(/\[redacted\]/);
  });

  it('maps network failures to RPC_UNAVAILABLE', () => {
    expect(translateTxError(ethersError({ code: 'TIMEOUT' })).code).toBe('RPC_UNAVAILABLE');
    expect(translateTxError(new TypeError('fetch failed')).code).toBe('RPC_UNAVAILABLE');
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

describe('formatTxError', () => {
  it('hides raw details unless asked', () => {
    const err = new WalletTxError('UNKNOWN', 'Title', 'Cause', 'Hint', 'RAW');
    expect(formatTxError(err, false)).not.toMatch(/RAW/);
    expect(formatTxError(err, false)).toMatch(/FHEW_DEBUG=1/);
    expect(formatTxError(err, true)).toMatch(/Technical details: RAW/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { FetchRequest } from 'ethers';
import { describeError, describeErrorShort, safeText } from '../../../src/cli/utils/userError.js';
import { WalletTxError } from '../../../src/core/token/txErrors.js';
import { maskUrl, maskUrlsInText } from '../../../src/utils/redact.js';

const KEY = 'PATHKEY0123456789abcdef';

afterEach(() => {
  delete process.env.SEPOLIA_RPC_URL;
  delete process.env.FHEW_DEBUG;
});

describe('maskUrl', () => {
  it('keeps scheme, host and port and hides everything else', () => {
    expect(maskUrl(`https://rpc.example:8545/v3/${KEY}?a=1`)).toBe('https://rpc.example:8545/…');
    expect(maskUrl(`https://user:pw@rpc.example`)).toBe('https://rpc.example/…');
    expect(maskUrl('https://rpc.example')).toBe('https://rpc.example');
    expect(maskUrl('not a url')).toBe('[redacted]');
  });

  it('masks URLs inside text', () => {
    expect(maskUrlsInText(`failed: https://a.example/${KEY} (x)`)).toBe(
      'failed: https://a.example/… (x)',
    );
  });
});

describe('describeError', () => {
  it('never shows the request URL of an ethers transport error', async () => {
    // A real ethers SERVER_ERROR: build a request to a closed port.
    const req = new FetchRequest(`http://127.0.0.1:1/qn/${KEY}?token=${KEY}`);
    req.timeout = 2_000;
    const err = await req.send().then(
      (r) => {
        r.assertOk();
        return null;
      },
      (e: unknown) => e,
    );
    const text = describeError(err ?? new Error(`request to http://h/${KEY} failed`));
    expect(text).not.toContain(KEY);
  });

  it('masks URLs and redacts keys in plain error messages', () => {
    const text = describeError(new Error(`bad response from https://rpc.example/${KEY}?k=1`));
    expect(text).toBe('bad response from https://rpc.example/…');
  });

  it('uses the translated wording for connection errors', () => {
    const err = Object.assign(
      new Error(`server response 500 (info={ "requestUrl": "x/${KEY}" })`),
      {
        code: 'SERVER_ERROR',
        shortMessage: 'server response 500',
      },
    );
    const text = describeError(err);
    expect(text).toMatch(/Could not reach the network/);
    expect(text).not.toContain(KEY);
  });

  it('keeps a wallet error title and hint, and falls back for empty errors', () => {
    expect(describeError(new WalletTxError('UNKNOWN', 'Title.', 'cause', 'Hint.'))).toBe(
      'Title. Hint.',
    );
    expect(describeError(undefined, 'Failed to add token')).toBe('Failed to add token');
    expect(describeError(new Error('Invalid password'))).toBe('Invalid password');
  });

  it('turns prompt failures without a terminal into one sentence', () => {
    const closed = Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    expect(describeError(closed)).toMatch(/no interactive terminal/);
    expect(describeError(new Error('readline was closed'))).toMatch(/no interactive terminal/);
    expect(describeError(Object.assign(new Error('x'), { name: 'ExitPromptError' }))).toBe(
      'Cancelled.',
    );
  });

  it('strips control characters and keeps one line', () => {
    expect(safeText('line one\u001b[2J\nline two')).toBe('line one [2J');
  });
});

describe('describeError with FHEW_DEBUG=1', () => {
  it('adds redacted technical details on their own line', () => {
    process.env.SEPOLIA_RPC_URL = `https://rpc.example/qn/${KEY}`;
    process.env.FHEW_DEBUG = '1';
    const err = Object.assign(
      new Error(`could not decode result data (info={ "responseBody": "for /qn/${KEY}" })`),
      { code: 'BAD_DATA', shortMessage: 'could not decode result data' },
    );
    const out = describeError(err);
    expect(out.split('\n')[0]).toBe('could not decode result data');
    expect(out).toMatch(/\nTechnical details: could not decode/);
    expect(out).not.toContain(KEY);
  });

  it('leaves details out unless asked', () => {
    expect(describeError(new Error('a\nb'))).toBe('a');
  });
});

describe('describeErrorShort', () => {
  it('uses the wallet title for known failures and never adds details', () => {
    process.env.FHEW_DEBUG = '1';
    expect(describeErrorShort(Object.assign(new Error('x'), { code: 'NETWORK_ERROR' }))).toBe(
      'Could not reach the network.',
    );
    expect(describeErrorShort(new Error("Relayer didn't response correctly. Bad JSON."))).toBe(
      "Zama's relayer could not complete the request.",
    );
  });
});

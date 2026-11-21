import { afterEach, describe, expect, it } from 'vitest';
import {
  maskUrl,
  redactDebugText,
  redactSecrets,
  rpcUrlSecretFragments,
} from '../../src/utils/redact.js';

afterEach(() => {
  delete process.env.ETHERSCAN_API_KEY;
  delete process.env.SEPOLIA_RPC_URL;
  delete process.env.MAINNET_RPC_URL;
});

describe('redactSecrets', () => {
  it('masks provider keys in URL paths and queries', () => {
    expect(redactSecrets('https://mainnet.infura.io/v3/0123456789abcdef0123')).toBe(
      'https://mainnet.infura.io/v3/[redacted]',
    );
    expect(redactSecrets('https://api.etherscan.io/v2/api?chainid=1&apikey=SECRET1')).toBe(
      'https://api.etherscan.io/v2/api?chainid=1&apikey=[redacted]',
    );
  });

  it('masks URL credentials and known secret settings by value', () => {
    process.env.ETHERSCAN_API_KEY = 'MYETHERSCANKEY';
    expect(redactSecrets('https://user:pw@rpc.example')).toBe('https://[redacted]@rpc.example');
    expect(redactSecrets('key is MYETHERSCANKEY here')).toBe('key is [redacted] here');
  });

  it('masks bearer tokens in any letter case', () => {
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      expect(redactSecrets(`authorization: ${scheme} abcdefgh12345678`)).toBe(
        `authorization: ${scheme} [redacted]`,
      );
    }
  });

  it('masks labelled private keys but keeps transaction hashes', () => {
    const hex = 'ab'.repeat(32);
    expect(redactSecrets(`privateKey: 0x${hex}`)).toBe('privateKey: [redacted]');
    expect(redactSecrets(`txHash=0x${hex}`)).toBe(`txHash=0x${hex}`);
  });
});

describe('redactSecrets: provider formats', () => {
  afterEach(() => {
    delete process.env.SEPOLIA_RPC_URL;
  });

  it('masks the configured RPC URL wholesale (Ankr/QuickNode path tokens)', () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.ankr.com/eth_sepolia/' + 'f'.repeat(64);
    expect(redactSecrets(`failed ${process.env.SEPOLIA_RPC_URL}`)).toBe('failed [redacted]');
  });

  it('masks dkey/auth query params, Bearer tokens and JSON apiKey fields', () => {
    expect(redactSecrets('https://x.drpc.org/?dkey=abc123')).toContain('dkey=[redacted]');
    expect(redactSecrets('https://x/?auth=tok')).toContain('auth=[redacted]');
    expect(redactSecrets('Authorization: Bearer abcdefgh12345')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redactSecrets('{"apiKey":"zzz"}')).toBe('{"apiKey":"[redacted]"}');
  });
});

describe('redactSecrets: pieces of the configured RPC URLs', () => {
  it('masks a path key echoed without the host (ethers responseBody)', () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/v2/SECRET500KEY999?apikey=QKEY12345';
    const text =
      'server response 500 (... "responseBody": "internal error for /v2/SECRET500KEY999?apikey=QKEY12345")';
    const out = redactSecrets(text);
    expect(out).not.toContain('SECRET500KEY999');
    expect(out).not.toContain('QKEY12345');
    expect(out).toContain('/v2/'); // short segments stay readable
  });

  it('collects long path segments, query values and credentials, raw and decoded', () => {
    const fragments = rpcUrlSecretFragments({
      MAINNET_RPC_URL:
        'https://user:pa%24%24word1@h.example/rpc/LONGSEGMENT1/x?k=v&token=abc%2Fdef12',
    });
    expect(fragments).toEqual(
      expect.arrayContaining([
        'LONGSEGMENT1',
        'abc%2Fdef12',
        'abc/def12',
        'pa%24%24word1',
        'pa$$word1',
      ]),
    );
    expect(fragments).not.toContain('rpc'); // too short to be a key
    expect(fragments).not.toContain('v'); // nor is a one-letter query value
  });

  it('masks long all-letter segments, anything after /v2/ or /v3/, and base64 creds', () => {
    const fragments = rpcUrlSecretFragments({
      MAINNET_RPC_URL: 'https://bob:hunter2pw@h.example/rpc/abcdefghijklmnopqrstuv/v3/shortk',
      SEPOLIA_RPC_URL: 'https://h.example/v2/allletterskey',
    });
    expect(fragments).toEqual(
      expect.arrayContaining([
        'abcdefghijklmnopqrstuv',
        'shortk',
        'allletterskey',
        Buffer.from('bob:hunter2pw').toString('base64'),
      ]),
    );
    expect(fragments).not.toContain('rpc');
    expect(fragments).not.toContain('v3');
  });

  it('ignores settings that are not URLs', () => {
    expect(rpcUrlSecretFragments({ SEPOLIA_RPC_URL: 'not a url' })).toEqual([]);
  });
});

describe('redactSecrets: no over-masking (regression)', () => {
  it('keeps network names, chain ids and words in a dRPC URL, masks the dkey', () => {
    const DKEY = 'AqKz1dRpcKeyx9Q2mVbN0pL7wErTyUiO';
    process.env.SEPOLIA_RPC_URL = `https://lb.drpc.org/ogrpc?network=sepolia&dkey=${DKEY}`;
    const out = redactSecrets(
      `network=sepolia chainid=11155111 eth_sepolia ogrpc failed for ?network=sepolia&dkey=${DKEY}`,
    );
    expect(out).toContain('network=sepolia');
    expect(out).toContain('chainid=11155111');
    expect(out).toContain('eth_sepolia');
    expect(out).toContain('ogrpc');
    expect(out).not.toContain(DKEY);
  });

  it('does not mask word-like path segments of the configured URL', () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/eth_sepolia/QNKEY1234abcd';
    const out = redactSecrets('eth_sepolia QNKEY1234abcd');
    expect(out).toBe('eth_sepolia [redacted]');
  });

  it("keeps the wallet's own explorer links whole", () => {
    const link = `https://sepolia.etherscan.io/tx/0x${'ab'.repeat(32)}`;
    expect(maskUrl(link)).toBe(link);
    expect(maskUrl('https://rpc.example/v2/KEY')).toBe('https://rpc.example/…');
  });
});

describe('redactDebugText (FHEW_DEBUG details)', () => {
  it('masks the whole configured path, base64 credentials and any letter case', () => {
    process.env.SEPOLIA_RPC_URL = 'https://al:pa55word@rpc.example/rpc?x=1';
    const b64 = Buffer.from('al:pa55word').toString('base64');
    const out = redactDebugText(`POST /rpc?x=1 Authorization: Basic ${b64} PA55WORD`);
    expect(out).not.toContain('/rpc?x=1');
    expect(out).not.toContain(b64);
    expect(out).not.toMatch(/pa55word/i);
  });

  it('matches key fragments case-insensitively', () => {
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/v2/MixedCaseKey12345';
    expect(redactDebugText('echo mixedcasekey12345')).toBe('echo [redacted]');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/utils/redact.js';

afterEach(() => {
  delete process.env.ETHERSCAN_API_KEY;
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

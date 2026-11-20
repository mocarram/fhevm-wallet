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

  it('masks labelled private keys but keeps transaction hashes', () => {
    const hex = 'ab'.repeat(32);
    expect(redactSecrets(`privateKey: 0x${hex}`)).toBe('privateKey: [redacted]');
    expect(redactSecrets(`txHash=0x${hex}`)).toBe(`txHash=0x${hex}`);
  });
});

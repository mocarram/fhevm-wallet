import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync, writeFileSync } from 'fs';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import {
  ENV_FILE_PATH,
  getEnvVar,
  listEnvVars,
  removeEnvVar,
  saveEnvVar,
} from '../../src/storage/paths.js';

beforeEach(() => wipeTestDataDir());

describe('.env writer', () => {
  it('rejects values that could inject extra settings or break parsing', () => {
    for (const bad of ['abc\nZAMA_MAINNET_API_KEY=evil', 'a b', 'x"y', "x'y", 'a#b', 'a\\b']) {
      expect(() => saveEnvVar('ETHERSCAN_API_KEY', bad)).toThrow(/not allowed/);
    }
    expect(() => saveEnvVar('bad key', 'x')).toThrow(/Invalid setting name/);
  });

  it('saves, updates and removes values in an owner-only file', () => {
    saveEnvVar('SEPOLIA_RPC_URL', 'https://rpc.example/v3/abc?x=1');
    saveEnvVar('ETHERSCAN_API_KEY', 'K1');
    saveEnvVar('ETHERSCAN_API_KEY', 'K2');
    expect(getEnvVar('ETHERSCAN_API_KEY')).toBe('K2');
    expect(getEnvVar('SEPOLIA_RPC_URL')).toBe('https://rpc.example/v3/abc?x=1');
    if (process.platform !== 'win32') expect(statSync(ENV_FILE_PATH).mode & 0o777).toBe(0o600);
    expect(removeEnvVar('ETHERSCAN_API_KEY')).toBe(true);
    expect(readFileSync(ENV_FILE_PATH, 'utf-8')).toBe(
      'SEPOLIA_RPC_URL=https://rpc.example/v3/abc?x=1\n',
    );
    expect(process.env.ETHERSCAN_API_KEY).toBeUndefined();
  });

  it('reads hand-edited quoted values', () => {
    saveEnvVar('SEPOLIA_RPC_URL', 'https://a.example');
    writeFileSync(
      ENV_FILE_PATH,
      'ETHERSCAN_API_KEY="quoted"\nSEPOLIA_RPC_URL=\'https://b.example\'\n',
    );
    expect(getEnvVar('ETHERSCAN_API_KEY')).toBe('quoted');
    expect(listEnvVars()).toEqual({
      ETHERSCAN_API_KEY: 'quoted',
      SEPOLIA_RPC_URL: 'https://b.example',
    });
  });
});

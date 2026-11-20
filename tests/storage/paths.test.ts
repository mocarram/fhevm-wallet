import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_FILE_PATH,
  getEnvVar,
  listEnvVars,
  loadEnv,
  removeEnvVar,
  saveEnvVar,
} from '../../src/storage/paths.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

beforeEach(() => {
  wipeTestDataDir();
  delete process.env.TEST_KEY;
});

describe('env file CRUD', () => {
  it('saveEnvVar creates the file and updates process.env', () => {
    saveEnvVar('TEST_KEY', 'value-1');
    expect(getEnvVar('TEST_KEY')).toBe('value-1');
    expect(process.env.TEST_KEY).toBe('value-1');
  });

  it('saveEnvVar overwrites an existing key', () => {
    saveEnvVar('TEST_KEY', 'first');
    saveEnvVar('TEST_KEY', 'second');
    expect(getEnvVar('TEST_KEY')).toBe('second');
  });

  it('removeEnvVar removes the line and reports presence', () => {
    saveEnvVar('TEST_KEY', 'value');
    expect(removeEnvVar('TEST_KEY')).toBe(true);
    expect(getEnvVar('TEST_KEY')).toBeUndefined();
    expect(process.env.TEST_KEY).toBeUndefined();
    expect(removeEnvVar('TEST_KEY')).toBe(false);
  });

  it('listEnvVars returns all key/value pairs', () => {
    saveEnvVar('A', '1');
    saveEnvVar('B', '2');
    expect(listEnvVars()).toEqual({ A: '1', B: '2' });
  });

  it('loadEnv injects env file values with override', () => {
    saveEnvVar('TEST_KEY', 'from-file');
    process.env.TEST_KEY = 'from-shell';
    loadEnv();
    expect(process.env.TEST_KEY).toBe('from-file');
  });

  it('reads only allow-listed keys from ./.env, never debug or backend switches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      'SEPOLIA_RPC_URL=https://rpc.example\nFHEW_DEBUG=1\nFHEW_BACKEND=mock\nNODE_OPTIONS=--inspect\n',
    );
    delete process.env.SEPOLIA_RPC_URL;
    try {
      const res = loadEnv(file);
      expect(process.env.SEPOLIA_RPC_URL).toBe('https://rpc.example');
      expect(process.env.FHEW_DEBUG).toBeUndefined();
      expect(process.env.FHEW_BACKEND).toBeUndefined();
      expect(res.fromCwd).toEqual(['SEPOLIA_RPC_URL']);
      expect(res.ignoredFromCwd).toEqual(['FHEW_DEBUG', 'FHEW_BACKEND', 'NODE_OPTIONS']);
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('./.env never overrides a value already in the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    writeFileSync(join(dir, '.env'), 'ETHERSCAN_API_KEY=from-cwd\n');
    process.env.ETHERSCAN_API_KEY = 'from-shell';
    try {
      expect(loadEnv(join(dir, '.env')).fromCwd).toEqual([]);
      expect(process.env.ETHERSCAN_API_KEY).toBe('from-shell');
    } finally {
      delete process.env.ETHERSCAN_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ENV_FILE_PATH lives under the test home', () => {
    expect(ENV_FILE_PATH).toMatch(/\.fhevm-wallet[/\\]\.env$/);
  });
});

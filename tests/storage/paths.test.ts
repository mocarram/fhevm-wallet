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

  it('ENV_FILE_PATH lives under the test home', () => {
    expect(ENV_FILE_PATH).toMatch(/\.fhevm-wallet[/\\]\.env$/);
  });
});

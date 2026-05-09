import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDefaultNetwork,
  getDefaultWallet,
  loadConfig,
  saveConfig,
  setDefaultWallet,
  updateConfig,
} from '../../src/storage/ConfigStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

beforeEach(() => {
  wipeTestDataDir();
});

describe('ConfigStore', () => {
  it('returns defaults when no file exists', () => {
    expect(loadConfig()).toEqual({ defaultNetwork: 'sepolia' });
    expect(getDefaultNetwork()).toBe('sepolia');
    expect(getDefaultWallet()).toBeUndefined();
  });

  it('persists and reloads config', () => {
    saveConfig({ defaultNetwork: 'mainnet', defaultWallet: 'work' });
    expect(loadConfig()).toEqual({ defaultNetwork: 'mainnet', defaultWallet: 'work' });
  });

  it('updateConfig merges patches', () => {
    saveConfig({ defaultNetwork: 'sepolia' });
    const merged = updateConfig({ defaultWallet: 'main' });
    expect(merged).toEqual({ defaultNetwork: 'sepolia', defaultWallet: 'main' });
  });

  it('setDefaultWallet persists across loads', () => {
    setDefaultWallet('alice');
    expect(getDefaultWallet()).toBe('alice');
  });

  it('falls back to defaults when file is corrupt', () => {
    const dir = join(homedir(), '.fhevm-wallet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json');
    expect(loadConfig()).toEqual({ defaultNetwork: 'sepolia' });
  });
});

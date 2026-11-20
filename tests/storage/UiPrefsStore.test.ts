import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultUiPrefs, loadUiPrefs, saveUiPrefs } from '../../src/storage/UiPrefsStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const FILE = () => join(homedir(), '.fhevm-wallet', 'ui-prefs.json');

beforeEach(() => {
  wipeTestDataDir();
});

describe('UiPrefsStore', () => {
  it('gives defaults when nothing is saved', () => {
    const p = loadUiPrefs();
    expect(p.unlockMinutes).toBe(15);
    expect(p.countdownSeconds).toBe(5);
    expect(p.networks.sepolia).toEqual({});
    expect(p.networks.mainnet).toEqual({});
  });

  it('round-trips sticky defaults per network with owner-only permissions', () => {
    const p = defaultUiPrefs();
    p.networks.sepolia.lastToken = '0xabc';
    p.networks.sepolia.lastSend = { token: '0xabc', to: '0xdef', amount: '25000000' };
    p.countdownSeconds = 3;
    saveUiPrefs(p);
    const back = loadUiPrefs();
    expect(back.networks.sepolia.lastSend?.amount).toBe('25000000');
    expect(back.networks.mainnet).toEqual({});
    expect(back.countdownSeconds).toBe(3);
    if (process.platform !== 'win32') expect(statSync(FILE()).mode & 0o077).toBe(0);
  });

  it('falls back to defaults on a corrupt or out-of-range file', () => {
    mkdirSync(join(homedir(), '.fhevm-wallet'), { recursive: true });
    writeFileSync(FILE(), '{not json');
    expect(loadUiPrefs()).toEqual(defaultUiPrefs());
    writeFileSync(FILE(), JSON.stringify({ countdownSeconds: 9999 }));
    expect(loadUiPrefs()).toEqual(defaultUiPrefs());
  });

  it('refuses to save invalid values', () => {
    const p = defaultUiPrefs();
    p.unlockMinutes = -1;
    expect(() => saveUiPrefs(p)).toThrow();
    expect(existsSync(FILE()) && readFileSync(FILE(), 'utf-8').includes('-1')).toBe(false);
  });
});

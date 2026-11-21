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
    p.networks.sepolia.lastToken = '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF';
    p.networks.sepolia.lastSend = {
      token: '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF',
      to: '0x6e1d3a0B7C25F9e84d1a6b3c0e7F52a9d8c194fa',
      amount: '25000000',
    };
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

  it('drops malformed sticky entries one by one instead of crashing later', () => {
    mkdirSync(join(homedir(), '.fhevm-wallet'), { recursive: true });
    const good = '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF';
    writeFileSync(
      FILE(),
      JSON.stringify({
        countdownSeconds: 3,
        networks: {
          sepolia: { lastToken: good, lastSend: { token: good, to: good, amount: '1.5' } },
          mainnet: { lastRecipient: 'bob', lastSend: { token: good, to: good, amount: '25' } },
        },
      }),
    );
    const p = loadUiPrefs();
    expect(p.countdownSeconds).toBe(3);
    expect(p.networks.sepolia.lastToken).toBe(good);
    expect(p.networks.sepolia.lastSend).toBeUndefined();
    expect(p.networks.mainnet.lastRecipient).toBeUndefined();
    expect(p.networks.mainnet.lastSend?.amount).toBe('25');
    for (const amount of ['0', '-1', '1e6', '18446744073709551616', '']) {
      writeFileSync(
        FILE(),
        JSON.stringify({ networks: { sepolia: { lastSend: { token: good, to: good, amount } } } }),
      );
      expect(loadUiPrefs().networks.sepolia.lastSend).toBeUndefined();
    }
  });

  it('refuses to save invalid values', () => {
    const p = defaultUiPrefs();
    p.unlockMinutes = -1;
    expect(() => saveUiPrefs(p)).toThrow();
    expect(existsSync(FILE()) && readFileSync(FILE(), 'utf-8').includes('-1')).toBe(false);
  });
});

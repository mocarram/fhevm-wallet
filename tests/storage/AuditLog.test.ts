import { beforeEach, describe, expect, it } from 'vitest';
import { getAuditLog, logEvent } from '../../src/storage/AuditLog.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

beforeEach(() => {
  wipeTestDataDir();
});

describe('AuditLog', () => {
  it('returns an empty array before any events are logged', () => {
    expect(getAuditLog()).toEqual([]);
  });

  it('appends events with timestamp and key=value details', () => {
    logEvent('WALLET_CREATED', { name: 'main', address: '0xabc' });
    const lines = getAuditLog();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] WALLET_CREATED name=main address=0xabc$/,
    );
  });

  it('preserves order across multiple calls', () => {
    logEvent('WALLET_CREATED', { name: 'a' });
    logEvent('TRANSFER', { to: '0xdead', amount: '5' });
    logEvent('WALLET_REMOVED', { name: 'a' });

    const events = getAuditLog().map((line) => line.split(' ')[1]);
    expect(events).toEqual(['WALLET_CREATED', 'TRANSFER', 'WALLET_REMOVED']);
  });

  it('limit returns the most recent N entries', () => {
    for (let i = 0; i < 5; i++) {
      logEvent('TRANSFER', { idx: String(i) });
    }
    const last2 = getAuditLog(2);
    expect(last2).toHaveLength(2);
    expect(last2.every((line) => line.includes('TRANSFER'))).toBe(true);
    expect(last2.at(-1)).toContain('idx=4');
  });

  it('limit of 0 returns all entries', () => {
    logEvent('WALLET_CREATED', { name: 'a' });
    logEvent('WALLET_REMOVED', { name: 'a' });
    expect(getAuditLog(0)).toHaveLength(2);
  });

  it('redacts secrets in values', () => {
    const key = '0x' + 'ab'.repeat(32);
    logEvent('TRANSFER', {
      note: `privateKey: ${key}`,
      rpc: 'https://eth.example/v2/SUPERSECRETAPIKEY123',
    });
    const [line] = getAuditLog();
    expect(line).not.toContain(key);
    expect(line).not.toContain('SUPERSECRETAPIKEY123');
  });

  it('strips C1 controls, line separators and bidi overrides from values', () => {
    logEvent('TOKEN_ADDED', { symbol: 'U\u202eSD\u009bC\u2028x' });
    const [line] = getAuditLog();
    expect(line).not.toMatch(/[\u202e\u009b\u2028]/);
  });

  it('cannot be tricked into writing an extra line', () => {
    logEvent('TOKEN_ADDED', { symbol: 'X\n[2026-01-01T00:00:00Z] WALLET_EXPORTED name=main' });
    expect(getAuditLog()).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('keeps the log owner-only', async () => {
    const { statSync } = await import('fs');
    const { join } = await import('path');
    const { DATA_DIR } = await import('../../src/storage/paths.js');
    logEvent('WALLET_CREATED', { name: 'a' });
    expect(statSync(join(DATA_DIR, 'audit.log')).mode & 0o777).toBe(0o600);
  });

  it('keeps network names, hashes and addresses intact even when a key fragment matches', () => {
    const addr = '0x000000000000000000000000000000000000dEaD';
    const hash = `0x${'ab'.repeat(32)}`;
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example/v2/sepolia000dEaD9';
    try {
      logEvent('TRANSFER', { network: 'sepolia', to: addr, txHash: hash, note: 'sepolia000dEaD9' });
      const line = getAuditLog().at(-1)!;
      expect(line).toContain(`to=${addr}`);
      expect(line).toContain(`txHash=${hash}`);
      expect(line).toContain('network=sepolia');
      expect(line).toContain('note=[redacted]');
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
    }
  });
});

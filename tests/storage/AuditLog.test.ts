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
});

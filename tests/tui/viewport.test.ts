import { createHash } from 'crypto';
import { getAddress } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { addAddress } from '../../src/storage/AddressBook.js';
import { upsertTransactions } from '../../src/storage/TransactionStore.js';
import { loadSnapshot } from '../../src/tui/snapshot.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness } from './harness.js';

beforeEach(() => wipeTestDataDir());

const addr = (s: string) =>
  getAddress('0x' + createHash('sha256').update(s).digest('hex').slice(0, 40));

/** 200 tokens, 200 contacts and 200 transfers (block 7000+i, so the last is newest). */
function seedMany(h: Harness, n = 200): void {
  for (let i = 0; i < n; i++) {
    addTokenWithInfo(
      { address: addr(`tok${i}`), name: `Seed Token ${i}`, symbol: `cT${i}`, decimals: 6 },
      'sepolia',
    );
    addAddress(`contact${i}`, addr(`c${i}`));
  }
  const me = h.s.wallet!.address;
  upsertTransactions(
    Array.from({ length: n }, (_, i) => ({
      txHash: '0x' + createHash('sha256').update(`tx${i}`).digest('hex'),
      type: 'transfer' as const,
      tokenAddress: addr('tok0'),
      tokenSymbol: 'cT0',
      from: me,
      to: addr(`c${i}`),
      amount: null,
      network: 'sepolia' as const,
      blockNumber: 7000 + i,
      timestamp: new Date(1_700_000_000_000 + i * 3600e3).toISOString(),
    })),
  );
  h.s.data = loadSnapshot('sepolia', me);
}

describe('long lists (200 rows)', () => {
  it('Home caps the balances to two rows with a count, and the whole menu stays', () => {
    const h = new Harness();
    seedMany(h);
    for (const [cols, rows] of [
      [100, 34],
      [80, 24],
    ]) {
      const t = h.text(cols, rows);
      expect(t).toMatch(/\+\d+ more · b Balances/);
      expect(t).toMatch(/0 {2}Quit/);
      expect(t).toMatch(/1 {2}Balances/);
      // No token entry is split across rows: every "cT<n> " is followed by its value.
      expect(t).not.toMatch(/cT\d+\s*\n/);
    }
  });

  it('History shows the newest first in a window that scrolls; header and menu stay', async () => {
    const h = new Harness();
    seedMany(h);
    await h.keys('h');
    let t = h.text(100, 34);
    expect(t).toMatch(/When +Type +Amount/);
    expect(t).toMatch(/contact199/); // block 7199, the newest
    expect(t).not.toMatch(/contact0\b/);
    expect(t).toMatch(/rows 1-\d+ of 20\d · pgdn scroll/);
    expect(t).toMatch(/Back/);
    await h.keys('{end}');
    t = h.text(100, 34);
    // The latest 200 are listed (the mock's synced transfers among them).
    expect(t).toMatch(/contact2\b/);
    expect(t).toMatch(/of 20\d · pgup scroll/);
    expect(t).toMatch(/When +Type +Amount/);
    await h.keys('{home}', '{pagedown}');
    t = h.text(100, 34);
    expect(t).not.toMatch(/contact199/);
    expect(t).toMatch(/pgup\/pgdn scroll/);
  });

  it('Address book keeps the filter line and the menu on screen', async () => {
    const h = new Harness();
    seedMany(h);
    await h.keys('7', '/', 'contact1', '{enter}');
    const t = h.text(80, 24);
    expect(t).toMatch(/\/ contact1 +\/ to change/);
    expect(t).toMatch(/Add contact/);
    expect(t).toMatch(/rows 1-\d+ of 111/);
    expect(t.split('\n')).toHaveLength(24);
  });

  it('a long menu shows a window around the cursor; End reaches its last item', async () => {
    const h = new Harness();
    seedMany(h);
    await h.keys('s');
    expect(h.screen).toBe('send-token');
    let t = h.text(100, 34);
    expect(t).toMatch(/● Token/);
    expect(t).toMatch(/↓ \d+ more/);
    await h.keys('{end}');
    t = h.text(100, 34);
    expect(t).toMatch(/❯ \s*Cancel/);
    expect(t).toMatch(/↑ \d+ more/);
    expect(t).toMatch(/● Token/);
    // The recipient list can be filtered.
    await h.keys('{home}', '{enter}');
    expect(h.screen).toBe('send-to');
    await h.keys('/', 'contact42', '{enter}');
    t = h.text(100, 34);
    expect(t).toMatch(/1 {2}contact42 /);
    expect(t).not.toMatch(/contact43/);
  });

  it('a multi-select list follows its cursor', async () => {
    const h = new Harness();
    seedMany(h);
    await h.keys('6', '2');
    expect(h.screen).toBe('token-remove');
    await h.keys('{end}');
    const t = h.text(100, 30);
    expect(t).toMatch(/❯ \[ \] cT199/);
    expect(t).toMatch(/Pick the tokens to stop tracking/);
  });
});

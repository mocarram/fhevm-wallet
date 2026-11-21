import { beforeEach, describe, expect, it } from 'vitest';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

describe('stable numbers and cursor', () => {
  it('the cursor stays on its item when Home rows appear above it', async () => {
    const h = new Harness();
    await h.keys('{down}'); // on Send
    h.text();
    // A send confirms in the background: "save contact" and "repeat" rows arrive.
    h.s.offerSave = STRANGER;
    h.text();
    expect(h.text()).toMatch(/❯ 2 {2}Send/);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-token');
  });

  it('History numbers do not move when there is nothing left to decrypt', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('h');
    const t = h.text();
    expect(t).toMatch(/1 {2}Decrypt amounts/);
    expect(t).toMatch(/4 {2}Disclose an amount/);
    expect(t).toMatch(/5 {2}Back/);
    await h.keys('1');
    expect(h.screen).toBe('history');
    expect(h.text()).toMatch(/already decrypted/);
  });
});

describe('explorer links', () => {
  const url = `https://sepolia.etherscan.io/tx/0x${'ab'.repeat(31)}cdef`;

  it('are never split across rows: shortened in the middle, clickable in full', async () => {
    const { line, link, plain, toAnsi, wrapLine } = await import('../../src/tui/text.js');
    const rows = wrapLine(line('  → ', link(url, 'cyan')), 80);
    expect(rows).toHaveLength(1);
    const text = plain(rows[0]);
    expect(text.length).toBeLessThanOrEqual(80);
    expect(text).toMatch(/^ {2}→ https:\/\/sepolia\.etherscan\.io\/tx\/0xab.*….*cdef$/);
    const ansi = toAnsi(rows[0], true);
    expect(ansi).toContain(`\x1b]8;;${url}\x07`);
    expect(toAnsi(rows[0], false)).not.toContain('\x1b]8');
  });

  it('Show latest in explorer uses the newest row the filter shows', async () => {
    const h = new Harness();
    await h.keys('h');
    await h.keys('/', 'eth', '{enter}', '2');
    const t = h.text(80, 30);
    expect(t).toMatch(/→ https:\/\/sepolia\.etherscan\.io\/tx\/0x/);
    const shown = h.s.history!.rows.find((r) => r.kind.startsWith('eth'))!;
    const hashEnd = shown.txHash.slice(-4);
    expect(t).toContain(hashEnd);
  });
});

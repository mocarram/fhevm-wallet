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

describe('command bar', () => {
  it('knows operators, find, network and unlock; errors are indented like other notes', async () => {
    const { parseCommand } = await import('../../src/tui/commandParser.js');
    expect(parseCommand('operators')).toEqual({ type: 'go', screen: 'operators' });
    expect(parseCommand('find')).toEqual({ type: 'go', screen: 'token-find' });
    expect(parseCommand('network')).toEqual({ type: 'go', screen: 'settings-network' });
    expect(parseCommand('unlock')).toEqual({ type: 'go', screen: 'unlock' });
    const h = new Harness();
    await h.keys(':', 'send nobody 1', '{enter}');
    expect(
      h
        .text()
        .split('\n')
        .find((l) => /nobody/.test(l)),
    ).toMatch(/^ {2}\S/);
  });

  it('operator crumbs say Tokens › Operators; the review fee reads like Send', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('6', '4');
    expect(h.text(160, 40)).toMatch(/Home › Tokens › Operators/);
    await h.keys('1', 'bob', '{enter}', '2');
    expect(h.screen).toBe('tx-review');
    expect(h.text(160, 40)).toMatch(/Tokens › Operators › Review/);
    expect(h.text()).toMatch(/Fee +≈ [\d.]+ ETH {3}you have/);
  });

  it('an empty operator address asks for one instead of "No contact called"', async () => {
    const h = new Harness();
    await h.keys('6', '4', '1', '{enter}');
    expect(h.text()).toMatch(/Type or paste the operator address/);
    expect(h.text()).not.toMatch(/No contact called ""/);
  });

  it('the recipient field takes a contact name too', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}', 'p', 'bob', '{enter}');
    expect(h.screen).toBe('send-amount');
    expect(h.s.send.to?.name).toBe('bob');
  });
});

describe('history sync notice', () => {
  it('is shown once, not after every refresh', async () => {
    const h = new Harness();
    const sync = h.backend.syncHistory.bind(h.backend);
    h.backend.syncHistory = async (...args) => ({
      ...(await sync(...args)),
      notice: 'History is limited to the last 50,000 blocks on public endpoints.',
    });
    await h.keys('h');
    expect(h.text()).toMatch(/! History is limited to the last 50,000 blocks/);
    await h.keys('3'); // Refresh
    expect(h.text()).not.toMatch(/limited to the last/);
  });
});

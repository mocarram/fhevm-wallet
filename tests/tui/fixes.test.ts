/**
 * Regression tests for the Phase 3 review findings.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { handleKey, tick } from '../../src/tui/app.js';
import { normalizeKey } from '../../src/tui/keys.js';
import { createWallet } from '../../src/core/wallet/WalletManager.js';
import { toAnsi } from '../../src/tui/text.js';
import { defaultUiPrefs, saveUiPrefs } from '../../src/storage/UiPrefsStore.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { BOB, BOB_LOOKALIKE, Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

async function toReview(h: Harness, amount = '25') {
  await h.keys('s', '{enter}', '{enter}', amount, '{enter}');
  expect(h.screen).toBe('send-review');
}

describe('"every action" unlock mode', () => {
  it('unlocking on Sign reaches the countdown, then locks once broadcast', async () => {
    const h = new Harness();
    h.s.data.prefs.unlockMinutes = 0;
    await toReview(h);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-sign');
    expect(h.text()).toMatch(/Unlocks for this send only/);
    // Simulate a successful unlock on Sign (no keystore in this harness).
    h.unlock(2);
    const { afterSignUnlock } = await import('../../src/tui/flows/send.js');
    h.queue.push(...afterSignUnlock(h.s));
    await h.settle();
    expect(h.screen).toBe('send-review');
    expect(h.s.signer).not.toBeNull(); // decryptAll did not re-lock on Review
    expect(h.text()).toMatch(/Simulation passed/);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-count');
    h.now += 6000;
    const fx = tick(h.s, h.now);
    expect(fx.map((e) => e.kind)).toEqual(['broadcast']);
    expect(h.s.signer).toBeNull(); // locked as soon as the send started
    h.queue.push(...fx);
    await h.settle();
    expect(h.text()).toMatch(/Sent 25\.00 cUSDC to bob/);
  });

  it('cancelling the send locks again', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.unlockMinutes = 0;
    await toReview(h);
    await h.keys('3'); // Cancel
    expect(h.screen).toBe('home');
    expect(h.s.signer).toBeNull();
  });
});

describe('prepared sends never outlive the unlock', () => {
  it('locking drops a prepared send, and a late check result is discarded', async () => {
    const h = new Harness({ unlocked: true });
    await toReview(h);
    expect(h.s.send.prepared).toBeDefined();
    await h.keys('L');
    expect(h.s.send.prepared).toBeUndefined();

    // A check that finishes after the lock must not store the prepared transfer.
    h.unlock();
    await h.keys('{escape}', '30', '{enter}'); // new draft starts a check
    const pending = h.queue.splice(0);
    await h.keys('L');
    for (const e of pending) h.apply(await e.run(h.deps));
    await h.settle();
    expect(h.s.send.prepared).toBeUndefined();
  });

  it('a stale check result re-checks the draft now on Review', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('s', '{enter}', '{enter}', '25');
    h.press('{enter}'); // Review for 25, check queued
    const stale = h.queue.splice(0);
    await h.keys('{escape}', '{ctrl-u}', '30', '{enter}'); // Review for 30 while 25 is checking
    for (const e of stale) h.apply(await e.run(h.deps));
    await h.settle();
    expect(h.screen).toBe('send-review');
    expect(h.s.send.value).toBe(30_000_000n);
    expect(h.text()).toMatch(/Simulation passed/);
  });

  it('the countdown cannot be doubled: Enter, ., : and digits while counting', async () => {
    const h = new Harness({ unlocked: true });
    await toReview(h);
    await h.keys('{enter}', '{enter}', '{enter}', '.', ':', '1', '{enter}');
    await h.advance(6000);
    await h.advance(6000);
    expect(h.ran.filter((k) => k === 'broadcast')).toHaveLength(1);
  });

  it('auto-lock waits while a countdown holds a checked send', async () => {
    const h = new Harness({ unlocked: true });
    h.s.unlockedUntil = h.now + 2000;
    await toReview(h);
    await h.keys('{enter}');
    await h.advance(3000);
    expect(h.screen).toBe('send-count');
    expect(h.s.signer).not.toBeNull();
    await h.advance(3000);
    expect(h.ran).toContain('broadcast');
  });
});

describe('unlock', () => {
  it('an unlock abandoned with Esc does not unlock later', async () => {
    const h = new Harness();
    const created = await createWallet('alice', 'secret-pass');
    h.s.wallet = { name: 'alice', address: created.address };
    h.press('b', '{enter}', 'secret-pass', '{enter}');
    // The keystore read is in flight; the user leaves.
    const inflight = h.queue.splice(0);
    await h.keys('{escape}');
    expect(inflight.map((e) => e.kind)).toContain('unlock');
    for (const e of inflight) h.apply(await e.run(h.deps));
    expect(h.s.signer).toBeNull();
    expect(h.screen).toBe('balances');
    expect(h.s.fieldError).toBeNull();
    // The same unlock, not abandoned, does unlock.
    await h.keys('{enter}', 'secret-pass', '{enter}');
    expect(h.s.signer?.address).toBe(created.address);
  });
});

describe('repeat last send', () => {
  it('re-runs the look-alike stop for a non-contact recipient', async () => {
    const prefs = defaultUiPrefs();
    const h0 = new Harness();
    prefs.networks.sepolia.lastSend = {
      token: h0.s.data.tokens[0].address,
      to: BOB_LOOKALIKE,
      amount: '1000000',
    };
    saveUiPrefs(prefs);
    const h = new Harness();
    await h.keys('.');
    expect(h.screen).toBe('send-check');
  });

  it('flags a first-time address on repeat', async () => {
    const prefs = defaultUiPrefs();
    const h0 = new Harness();
    prefs.networks.sepolia.lastSend = {
      token: h0.s.data.tokens[0].address,
      to: STRANGER,
      amount: '1000000',
    };
    saveUiPrefs(prefs);
    const h = new Harness();
    await h.keys('.');
    expect(h.screen).toBe('send-review');
    expect(h.text()).toMatch(/First time sending to this address/);
    expect(h.text()).toMatch(/Repeating your last send/);
  });
});

describe('amount display', () => {
  it('Review shows the ungrouped value and base units and warns on "1,500"', async () => {
    const h = new Harness();
    await toReview(h, '1,000');
    const t = h.text();
    expect(t).toMatch(/= 1000 cUSDC · 1000000000 base units/);
    expect(t).toMatch(/commas group thousands here/);
    await h.keys('{escape}', '{ctrl-u}', '1.5', '{enter}');
    expect(h.text()).not.toMatch(/commas group thousands/);
  });
});

describe('terminal safety', () => {
  it('toAnsi strips control, bidi and invisible characters from every segment', () => {
    const out = toAnsi([{ t: 'bob\x1b[31m‮evil​\x9b', s: ['bold'] }], true);
    expect(out).not.toMatch(/\x1b\[31m|‮|​|\x9b/);
    expect(out.startsWith('\x1b[1m')).toBe(true);
  });

  it('normalizeKey drops C1 controls', () => {
    expect(normalizeKey('\x9b', {})).toBeNull();
    expect(normalizeKey('é', {})).toBe('é');
  });

  it('contact names from addressbook.json are cleaned before display', async () => {
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const h0 = new Harness();
    void h0;
    writeFileSync(
      join(homedir(), '.fhevm-wallet', 'addressbook.json'),
      JSON.stringify({
        entries: [{ name: 'bob‮evil', address: BOB, addedAt: new Date().toISOString() }],
      }),
    );
    const h = new Harness({ seed: false });
    expect(h.s.data.contacts[0].name).not.toMatch(/‮/);
  });

  it('a lowercase l locks too (documented alongside L)', () => {
    const h = new Harness({ unlocked: true });
    handleKey(h.s, 'l');
    expect(h.s.signer).toBeNull();
  });
});

/**
 * Regression tests for the Phase 3 review findings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('backing out of Review with Esc locks at once', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.unlockMinutes = 0;
    await toReview(h);
    expect(h.s.send.prepared).toBeDefined();
    await h.keys('{escape}');
    expect(h.screen).not.toBe('send-review');
    expect(h.s.signer).toBeNull();
    expect(h.s.send.prepared).toBeUndefined();
  });

  it('leaving the send by Esc all the way to Home, or the command bar, locks', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.unlockMinutes = 0;
    await toReview(h);
    await h.keys('{escape}', '{escape}', '{escape}', '{escape}');
    expect(h.screen).toBe('home');
    expect(h.s.signer).toBeNull();

    const h2 = new Harness({ unlocked: true });
    h2.s.data.prefs.unlockMinutes = 0;
    await toReview(h2);
    await h2.keys(':', 'h', 'i', 's', 't', 'o', 'r', 'y', '{enter}'); // command bar jump
    expect(h2.screen).toBe('history');
    expect(h2.s.signer).toBeNull();
    expect(h2.s.send.prepared).toBeUndefined();
  });

  it('a timed unlock survives backing out of Review', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.unlockMinutes = 15;
    await toReview(h);
    await h.keys('{escape}');
    expect(h.s.signer).not.toBeNull();
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

describe('verifier findings', () => {
  it('the command bar never echoes a typed URL with its key', async () => {
    const h = new Harness();
    await h.keys(':https://rpc.example.org/v3/SECRETKEY123456{enter}');
    const t = h.text();
    expect(t).toMatch(/Unknown command "https:\/\/rpc\.example\.org\/…"/);
    expect(t).not.toMatch(/SECRETKEY123456/);
    expect(h.s.cmd).toBeNull();
  });

  it('help descriptions wrap inside the box', async () => {
    const h = new Harness();
    await h.keys('8', '?');
    const lines = h.text(100, 40).split('\n');
    const box = lines.filter((l) => l.startsWith('    ') && l.length > 10);
    const widths = new Set(
      lines.filter((l) => /^ {2}\S|^ {4}/.test(l)).map((l) => l.trimEnd().length),
    );
    expect(widths.size).toBeGreaterThan(0);
    expect(h.text()).toMatch(/Change the setting/);
    for (const l of box) expect(l.trimEnd().length).toBeLessThanOrEqual(2 + 64);
  });

  it('checking an RPC URL with the mock says plainly it was not saved', async () => {
    const h = new Harness();
    await h.keys('8', '3', '2', 'https://rpc.example.org', '{enter}');
    expect(h.text()).toMatch(/Checked: it answers with chain id 11155111/);
    expect(h.text()).toMatch(/Not saved: the offline mock never changes\s+RPC settings/);
    expect(h.text()).not.toMatch(/✔ Saved/);
  });
});

describe('back up the recovery phrase', () => {
  it('shows the phrase again on the private screen after the password', async () => {
    const h = new Harness();
    const created = await createWallet('alice', 'secret-pass');
    h.s.wallet = { name: 'alice', address: created.address };
    await h.keys('5'); // Wallets
    const backup = h.text().match(/(\d) {2}Back up alice/);
    expect(backup).not.toBeNull();
    await h.keys(backup![1]);
    expect(h.text()).toMatch(/3 {2}Show recovery phrase on a private screen/);
    await h.keys('3', 'wrong', '{enter}');
    expect(h.text()).toMatch(/did not unlock alice/);
    expect(h.secrets).toHaveLength(0);
    await h.keys('secret-pass', '{enter}');
    expect(h.secrets).toHaveLength(1);
    expect(h.secrets[0].title).toBe('Recovery phrase for alice');
    expect(h.secrets[0].lines.join(' ')).toContain(created.mnemonic.split(' ')[0]);
    expect(h.screen).toBe('wallets');
    expect(h.s.inputs.password).toBeUndefined();
  });
});

describe('unlock failures other than a wrong password (N6)', () => {
  it('Export recovery phrase says "did not unlock" only for a wrong password', async () => {
    const { exportRecoveryPhrase } = await import('../../src/tui/flows/wallet.js');
    const { saveWalletKeystore } = await import('../../src/storage/WalletStore.js');
    const h = new Harness();
    // No keystore for alice yet: that is not a wrong password.
    h.s.inputs.password = 'pw';
    h.queue.push(...exportRecoveryPhrase(h.s));
    await h.settle();
    expect(h.s.fieldError?.[0]).not.toMatch(/did not unlock/);
    // With a keystore, a wrong password is said as such.
    const ks = h.signer.encryptSync('right', { scrypt: { N: 1024 } } as never);
    saveWalletKeystore('alice', ks, h.signer.address);
    h.s.inputs.password = 'wrong';
    h.queue.push(...exportRecoveryPhrase(h.s));
    await h.settle();
    expect(h.s.fieldError?.[0]).toBe('That password did not unlock alice.');
  });
});

describe('small Review and status bar fixes (L4)', () => {
  it('fees below 0.0001 ETH show two significant digits, never 0.0000', async () => {
    const { formatFee } = await import('../../src/tui/format.js');
    expect(formatFee(21_000_000_000_000n)).toBe('0.000021');
    expect(formatFee(21_400_000_000_001n)).toBe('0.000022'); // an upper bound rounds up
    expect(formatFee(300_000_000_000_000n)).toBe('0.0003');
    expect(formatFee(5n)).toBe('0.000000000000000005');
  });

  it('the lock badge says 15m right after a 15-minute unlock, not 16m', async () => {
    const h = new Harness();
    h.s.signer = h.signer;
    h.s.unlockedUntil = h.now + 15 * 60_000 + 800; // set a moment after the frame's clock
    expect(h.text()).toMatch(/unlocked 15m/);
    h.s.unlockedUntil = h.now + 15 * 60_000 - 5_000; // a few seconds later: still 15m
    expect(h.text()).toMatch(/unlocked 15m/);
    h.s.unlockedUntil = h.now + 30_000;
    expect(h.text()).toMatch(/unlocked <1m/);
  });

  it('Ctrl+C on Balances with nothing in progress goes Home without "Cancelled"', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    await h.keys('{ctrl-c}');
    expect(h.screen).toBe('home');
    expect(h.text()).not.toMatch(/Cancelled/);
  });
});

describe('a history sync that stopped early (live check)', () => {
  it('shows "Synced up to block N" with the warning mark on every refresh', async () => {
    const h = new Harness({ unlocked: true });
    const notice = 'Synced up to block 41. History from block 42 to 99 not searched yet for cUSDC.';
    vi.spyOn(h.backend, 'syncHistory').mockResolvedValue({
      newCount: 0,
      method: 'rpc',
      complete: false,
      notice,
    });
    await h.keys('h');
    expect(h.text(160)).toContain(`! ${notice}`);
    await h.keys('{escape}');
    await h.keys('h');
    expect(h.text(160)).toContain(`! ${notice}`);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { loadSnapshot } from '../../src/tui/snapshot.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { BOB, BOB_LOOKALIKE, Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

/** A harness tracking both mock tokens plus `extra` more. */
function withTokens(extra: number, opts: { unlocked?: boolean } = {}): Harness {
  const h = new Harness(opts);
  addTokenWithInfo(h.backend.catalogue('sepolia')[1], 'sepolia');
  for (let i = 0; i < extra; i++) {
    const address =
      '0x' +
      String(i + 1)
        .repeat(40)
        .slice(0, 40);
    addTokenWithInfo({ address, name: `Extra ${i}`, symbol: `cX${i}`, decimals: 6 }, 'sepolia');
  }
  h.s.data = loadSnapshot('sepolia', h.s.wallet?.address);
  return h;
}

describe('one signature decrypts all tracked balances', () => {
  it('signs once for every token and batches the decrypt', async () => {
    const h = withTokens(3, { unlocked: true });
    const sign = vi.spyOn(h.signer, 'signTypedData');
    await h.keys('1'); // Balances: decrypts on enter
    expect(h.s.data.tokens).toHaveLength(5);
    expect(Object.keys(h.s.balances)).toHaveLength(5);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(h.backend.userDecryptRequests).toBe(1);
    // Force refresh: new request, same signature.
    await h.keys('1');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(h.backend.userDecryptRequests).toBe(2);
  });

  it('drops the keypair and signature on lock and on auto-lock', async () => {
    const h = withTokens(0, { unlocked: true });
    await h.keys('1');
    const first = h.s.decryptSession!;
    expect(first.active).toBe(true);
    await h.keys('{escape}', 'L');
    expect(h.s.decryptSession).toBeNull();
    expect(first.active).toBe(false);

    h.unlock(1);
    await h.keys('1');
    const second = h.s.decryptSession!;
    expect(second).not.toBe(first);
    await h.advance(2 * 60_000);
    expect(h.s.signer).toBeNull();
    expect(h.s.decryptSession).toBeNull();
    expect(second.active).toBe(false);
  });

  it('keeps old values on Home with a spinner while refreshing in the background', async () => {
    const h = withTokens(0, { unlocked: true });
    await h.keys('1', '{escape}');
    h.press('1'); // decrypt queued, not run yet
    await h.keys('{escape}');
    // The queue already ran; start a refresh without settling to see the in-between frame.
    h.queue.push(...(await import('../../src/tui/flows/data.js')).decryptAll(h.s, true));
    const t = h.text();
    expect(t).toMatch(/cUSDC 1,250\.00 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(t).toMatch(/updating/);
    await h.settle();
    expect(h.text()).toMatch(/decrypted just now/);
  });
});

describe('history amounts', () => {
  it('decrypts incoming amounts once unlocked and caches them by handle', async () => {
    const h = new Harness();
    await h.keys('h');
    expect(h.text()).toMatch(/received\s+encrypted/);
    expect(h.text()).toMatch(/Decrypt amounts/);
    await h.keys('1'); // Decrypt amounts → unlock
    expect(h.screen).toBe('unlock');
    // No keystore in the harness: simulate a successful unlock like the unlock flow does.
    h.unlock();
    h.s.stack.pop();
    await h.keys('1'); // now unlocked: decrypts
    expect(h.text()).toMatch(/received\s+\+25\.00\s+cUSDC/);
    // Cached: a fresh, locked session still shows it.
    const h2 = new Harness();
    h2.s.wallet = h.s.wallet;
    await h2.keys('h');
    expect(h2.text()).toMatch(/\+25\.00/);
  });
});

describe('operators', () => {
  it('grants with an expiry through review, confirm and countdown, then revokes', async () => {
    const h = new Harness();
    h.now = Date.now(); // the mock checks expiries against the wall clock
    h.unlock();
    h.s.data.prefs.countdownSeconds = 3;
    await h.keys('6', '4'); // Tokens › Operators
    expect(h.screen).toBe('operators');
    expect(h.text()).toMatch(/bob\s+0x91Be.*not an operator/);
    await h.keys('1', 'bob', '{enter}');
    expect(h.screen).toBe('operator-expiry');
    await h.keys('2'); // 1 day
    expect(h.screen).toBe('tx-review');
    const review = h.text();
    expect(review).toMatch(/Let bob move your cUSDC until/);
    expect(review).toMatch(/ALL of your cUSDC/);
    expect(review).toMatch(/Simulation passed/);
    await h.keys('1'); // Confirm
    expect(h.screen).toBe('tx-count');
    await h.keys('{escape}');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/Stopped\. Nothing was sent/);
    await h.keys('1');
    await h.advance(3_000);
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/bob is now an operator until/);
    expect(
      (await h.backend.operatorStatus(h.s.operators!.token, h.signer.address, [BOB], 'sepolia'))[
        BOB.toLowerCase()
      ],
    ).toBe(true);

    await h.keys('6', '4');
    expect(h.text()).toMatch(/bob.*\boperator\b/);
    // ERC-7984 has no expiry getter: the grant made here is remembered and shown.
    expect(h.text()).toMatch(/bob.*operator until \w{3} \d+ \d{4}/);
    await h.keys('2'); // Revoke
    await h.keys('1'); // bob
    expect(h.text()).toMatch(/Stop bob from moving your cUSDC/);
    await h.keys('1');
    await h.advance(3_000);
    expect(h.text()).toMatch(/Revoked: bob can no longer move your cUSDC/);
  });

  it('refuses to revoke an address that is not an operator (nothing is sent)', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('6', '4', '2');
    expect(h.screen).toBe('operator-revoke');
    const another = h.text().match(/(\d) {2}Another address/)![1];
    await h.keys(another, STRANGER, '{enter}');
    expect(h.screen).toBe('operator-addr');
    expect(h.text()).toMatch(/is not an operator for cUSDC/);
    expect(h.text()).toMatch(/Nothing was signed or sent/);
    expect(h.s.txAction).toBeNull();
  });

  it('never grants "forever" without the typed word', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('6', '4', '1', 'bob', '{enter}', '5');
    expect(h.screen).toBe('operator-forever');
    await h.keys('yes', '{enter}');
    expect(h.screen).toBe('operator-forever');
    expect(h.text()).toMatch(/Type forever/);
    await h.keys('{backspace}{backspace}{backspace}', 'forever', '{enter}');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/with no expiry/);
  });

  it('stops a grant to a look-alike of a contact, like Send', async () => {
    // Regression: a poisoned address went straight to the expiry step.
    const h = new Harness({ unlocked: true });
    await h.keys('6', '4', '1', BOB_LOOKALIKE, '{enter}');
    expect(h.screen).toBe('operator-check');
    expect(h.text()).toMatch(/looks like your contact bob, but it is a different address/);
    await h.keys('1'); // Grant to bob instead
    expect(h.screen).toBe('operator-expiry');
    expect(h.s.stack[h.s.stack.length - 1].params.address).toBe(BOB);
    expect(h.text()).not.toMatch(/First time/);
  });

  it('a confirmed look-alike or new address is flagged on Review', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('6', '4', '1', BOB_LOOKALIKE, '{enter}', '2');
    expect(h.screen).toBe('operator-expiry');
    expect(h.text()).toMatch(/First time using this address/);
    await h.keys('2'); // 1 day
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/look-alike of a contact/);
    expect(h.text()).toMatch(/First time using this address/);
  });

  it('shows SENT_UNCONFIRMED with the hash when the confirmation is lost', async () => {
    const h = new Harness({ unlocked: true, mock: { fail: 'unconfirmed' } });
    h.s.data.prefs.countdownSeconds = 0;
    await h.keys('6', '4', '1', 'bob', '{enter}', '1');
    await h.keys('1');
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/may have been sent/);
    expect(h.text()).toMatch(/Do not send it again/);
    expect(h.s.lastSendError?.error.txHash).toMatch(/^0x/);
  });
});

describe('disclose', () => {
  it('requests, then publishes a received amount', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.countdownSeconds = 0;
    await h.keys('h');
    const items = h.text();
    expect(items).toMatch(/Disclose an amount/);
    // Decrypt amounts (dimmed: decrypted already), Show latest, Refresh, Disclose: the
    // numbers never move when the decrypt item has nothing to do.
    expect(items).toMatch(/1 {2}Decrypt amounts/);
    await h.keys('4');
    expect(h.screen).toBe('disclose-pick');
    await h.keys('1');
    expect(h.screen).toBe('disclose');
    expect(h.text()).toMatch(/Status\s+private/);
    await h.keys('1');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/cannot be made private again/);
    await h.keys('1');
    expect(h.text()).toMatch(/Step 1 of 2 done/);
    await h.keys('h', '4', '1');
    expect(h.text()).toMatch(/pending public decryption/);
    await h.keys('1');
    await h.keys('1');
    expect(h.text()).toMatch(/Disclosed 25\.00 cUSDC publicly/);
    await h.keys('h');
    expect(h.text()).toMatch(/\+25\.00.*public/);
  });
});

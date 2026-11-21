/**
 * Wrap / Unwrap in the TUI, driven through the real core with the MockBackend
 * (mock cUSDC wraps a 6-decimal USDC at rate 1; cDAI an 18-decimal DAI at rate 1e12).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { listUnwraps } from '../../src/storage/UnwrapStore.js';
import { loadSnapshot } from '../../src/tui/snapshot.js';
import { finishPending } from '../../src/tui/flows/wrap.js';
import { lockWallet } from '../../src/tui/state.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness } from './harness.js';

beforeEach(() => wipeTestDataDir());

/** Wait out the countdown (and let the background broadcast finish). */
async function confirm(h: Harness) {
  await h.keys('1'); // Confirm
  await h.advance(10_000);
}

describe('Wrap', () => {
  it('Balances › w: shows both balances, the exact result, the steps; wraps and re-decrypts', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    expect(h.text()).toMatch(/↳ wraps USDC · 500\.00 USDC public in this wallet/);
    await h.keys('w'); // the only wrapper: straight to its Wrap screen
    expect(h.screen).toBe('wrap');
    let t = h.text();
    expect(t).toMatch(/Wrap USDC into cUSDC/);
    expect(t).toMatch(/USDC\s+500\.00\s+public, in this wallet/);
    expect(t).toMatch(/cUSDC\s+1,250\.00\s+confidential/);
    expect(t).toMatch(/1 cUSDC = 1 USDC/);
    await h.keys('25');
    expect(h.text()).toMatch(/You get 25 cUSDC\./);
    await h.keys('{enter}');
    expect(h.screen).toBe('tx-review');
    t = h.text();
    expect(t).toMatch(/Wrap 25\.00 USDC into 25\.00 cUSDC/);
    expect(t).toMatch(/wrapped amount is public on-chain/);
    expect(t).toMatch(/Approve cUSDC to take exactly 25\.00 USDC \(not unlimited\)/);
    expect(t).toMatch(/Wrap \(simulated after the approval\)/);
    expect(t).toMatch(/Simulation passed/);
    await confirm(h);
    expect(h.screen).toBe('home');
    t = h.text();
    expect(t).toMatch(/✔ Wrapped 25\.00 USDC → 25\.00 cUSDC/);
    expect(t).toMatch(/cUSDC 1,250\.00 → 1,275\.00/);
    expect(h.s.balances[h.backend.catalogue('sepolia')[0].address.toLowerCase()].value).toBe(
      1_275_000_000n,
    );
  });

  it('refuses a wrap that mints 0 and shows dust before anything is signed', async () => {
    const h = new Harness({ unlocked: true });
    const cdai = h.backend.catalogue('sepolia')[1];
    addTokenWithInfo(cdai, 'sepolia');
    h.s.data = loadSnapshot('sepolia', h.signer.address);
    await h.keys(':wrap 0.0000001 cdai{enter}');
    // cDAI was not checked yet: the picker checks it, then goes on to its Wrap screen.
    expect(h.screen).toBe('wrap');
    expect(h.text()).toMatch(/That wraps to 0 cDAI: the smallest amount is 0\.000001 DAI\./);
    await h.keys('{enter}');
    expect(h.screen).toBe('wrap'); // Continue refused
    expect(h.s.txAction).toBeNull();
    await h.keys('{ctrl-u}', 'max');
    const t = h.text();
    expect(t).toMatch(/You get 1,000 cDAI\./);
    expect(t).toMatch(/0\.000000123456789 DAI stays in your wallet \(below 1 cDAI unit\)\./);
  });

  it(':wrap 5 cusdc opens the screen with the amount filled in', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b'); // learns the wrapper
    await h.keys(':wrap 5 cusdc{enter}');
    expect(h.screen).toBe('wrap');
    expect(h.text()).toMatch(/You get 5 cUSDC\./);
    await h.keys('{escape}', ':unwrap{enter}');
    expect(h.screen).toBe('unwrap');
  });
});

describe('Unwrap', () => {
  it('Tab switches to Unwrap; one confirm sends both steps and the ERC-20 arrives', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    await h.keys('w', '{tab}');
    expect(h.screen).toBe('unwrap');
    expect(h.text()).toMatch(/Unwrap cUSDC into USDC/);
    await h.keys('10');
    expect(h.text()).toMatch(/You get 10\.00 USDC \(public\)\./);
    await h.keys('{enter}');
    const t = h.text();
    expect(t).toMatch(/Unwrap 10\.00 cUSDC into 10\.00 USDC/);
    expect(t).toMatch(/unwrapped amount becomes public/);
    expect(t).toMatch(/Step 1\s+Request: burns 10\.00 cUSDC/);
    expect(t).toMatch(/Step 2\s+Finish: publish the decrypted amount/);
    await confirm(h);
    expect(h.text()).toMatch(/✔ Unwrapped 10\.00 cUSDC: 10\.00 USDC arrived/);
    expect(listUnwraps({ open: true })).toEqual([]);
    expect(listUnwraps()[0]).toMatchObject({ state: 'finished', finishedBy: 'wallet' });
  });

  it('refuses more than the decrypted balance on the screen', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    await h.keys('w', '{tab}', '2000');
    expect(h.text()).toMatch(/That's more than your 1,250 cUSDC\./);
    expect(h.text()).toMatch(/burn 0/);
  });

  it('a pending unwrap shows on Home; Finish unwrap checks the chain and sends step 2 once', async () => {
    const h = new Harness({ unlocked: true, mock: { fail: 'public-pending' } });
    await h.keys('b');
    await h.keys('w', '{tab}', '10', '{enter}');
    await confirm(h);
    expect(h.text()).toMatch(/Step 1 done: 10\.00 cUSDC → USDC\. Not decryptable yet/);
    await h.settle();
    expect(h.text()).toMatch(/Finish unwrap: 10\.00 cUSDC → USDC\s+step 1 done, waiting to finish/);

    // Still not decryptable: the Review's check says so and nothing is sent.
    await h.keys('u');
    expect(h.text()).toMatch(/not decryptable yet/i);
    expect(listUnwraps({ open: true })[0].state).toBe('requested');

    // Decryption ready now.
    (h.backend as unknown as { opts: { fail?: string } }).opts.fail = undefined;
    await h.keys('{ctrl-c}', 'u');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/Finish unwrap: 10\.00 cUSDC → USDC/);
    expect(h.text()).toMatch(/You get\s+10\.00 USDC/);
    await confirm(h);
    expect(h.text()).toMatch(/✔ Unwrapped 10\.00 cUSDC: 10\.00 USDC arrived/);
    await h.settle();
    expect(h.text()).not.toMatch(/Finish unwrap:/);
    expect(listUnwraps()[0]).toMatchObject({ state: 'finished' });
  });
});

describe('a wrap that ends unconfirmed', () => {
  it('keeps the hash, says not to send again and re-checks later', async () => {
    const h = new Harness({ unlocked: true, mock: { fail: 'unconfirmed' } });
    await h.keys('b');
    await h.keys('w');
    await h.keys('25{enter}');
    await confirm(h);
    expect(h.s.lastSendError?.error.code).toBe('SENT_UNCONFIRMED');
    expect(h.s.lastSendError?.error.txHash).toMatch(/^0x/);
    expect(h.text()).toMatch(/Do not send it again until you have checked it/);
    expect(h.s.recheckAt).toBeGreaterThan(h.now);
  });
});

describe('step 2 in the background and the lock (S3, N4)', () => {
  /** Start an unwrap of 10 cUSDC up to the confirm. */
  async function unwrapReview(h: Harness) {
    await h.keys('b');
    await h.keys('w', '{tab}', '10', '{enter}');
    expect(h.screen).toBe('tx-review');
  }

  it('a lock during the background finish stops it: nothing signed, Home offers Finish unwrap', async () => {
    const h = new Harness({ unlocked: true });
    await unwrapReview(h);
    const real = h.backend.prepareFinalizeUnwrap.bind(h.backend);
    let sent = false;
    vi.spyOn(h.backend, 'prepareFinalizeUnwrap').mockImplementation(async (...a) => {
      const p = await real(...a);
      lockWallet(h.s); // the user locks while the decryption and simulation run
      const send = p.send;
      return {
        ...p,
        send: (hooks) => {
          sent = true;
          return send(hooks);
        },
      };
    });
    await confirm(h);
    expect(sent).toBe(false);
    expect(listUnwraps({ open: true })[0]).toMatchObject({ state: 'requested' });
    expect(listUnwraps()[0].finalizeTxHash).toBeUndefined();
    const t = h.text();
    expect(t).toMatch(/Step 1 done: 10\.00 cUSDC → USDC\. Step 2 not sent yet/);
    expect(t).toMatch(/The wallet locked: unlock, then Home › Finish unwrap sends step 2/);
    await h.settle();
    expect(h.text()).toMatch(/Finish unwrap: 10\.00 cUSDC → USDC/);
  });

  it('"every action" mode: the Review says so, step 2 waits for Home after unlocking', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    await h.keys('w', '{tab}', '10');
    h.s.data.prefs.unlockMinutes = 0;
    await h.keys('{enter}');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/locks after every action: after step 1, unlock and use/);
    const spy = vi.spyOn(h.backend, 'prepareFinalizeUnwrap');
    await confirm(h);
    expect(spy).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/locks after every action: unlock, then Home › Finish unwrap/);
    expect(listUnwraps({ open: true })[0].state).toBe('requested');
  });

  it('Home cannot start a second finish while the background one runs', async () => {
    const h = new Harness({ unlocked: true });
    await unwrapReview(h);
    const real = h.backend.prepareFinalizeUnwrap.bind(h.backend);
    let during: { fx: number; flash: string; value?: string } | undefined;
    vi.spyOn(h.backend, 'prepareFinalizeUnwrap').mockImplementation(async (...a) => {
      h.s.data = loadSnapshot('sepolia', h.signer.address);
      const id = h.s.data.unwraps[0].id;
      const fx = finishPending(h.s, id);
      during = {
        fx: fx.length,
        flash: (h.s.flash ?? []).map((l) => l.map((x) => x.t).join('')).join('\n'),
        value: h.text().match(/Finish unwrap: .*/)?.[0],
      };
      return real(...a);
    });
    await confirm(h);
    expect(during?.fx).toBe(0);
    expect(during?.flash).toMatch(/being sent in the background/);
    expect(h.s.wrap.background).toEqual([]);
    expect(listUnwraps()[0]).toMatchObject({ state: 'finished' });
  });

  it('wrap and unwrap success notices link the transaction on the explorer', async () => {
    const h = new Harness({ unlocked: true });
    await unwrapReview(h);
    await confirm(h);
    const e = listUnwraps()[0];
    expect(h.text(200)).toContain(h.backend.explorerTxUrl(e.finalizeTxHash!, 'sepolia'));
    const notice = h.s.notice!.flat();
    expect(notice.some((x) => x.href?.includes(e.finalizeTxHash!))).toBe(true);
    await h.keys('b', 'w', '{ctrl-u}', '5{enter}');
    await confirm(h);
    expect(h.text()).toMatch(/✔ Wrapped 5\.00 USDC/);
    expect(h.s.notice!.flat().some((x) => x.href?.includes('/tx/0x'))).toBe(true);
  });
});

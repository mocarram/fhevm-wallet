/**
 * Wrap / Unwrap in the TUI, driven through the real core with the MockBackend
 * (mock cUSDC wraps a 6-decimal USDC at rate 1; cDAI an 18-decimal DAI at rate 1e12).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addTokenWithInfo } from '../../src/core/token/TokenRegistry.js';
import { listUnwraps } from '../../src/storage/UnwrapStore.js';
import { loadSnapshot } from '../../src/tui/snapshot.js';
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
    expect(h.text()).toMatch(/↳ wraps USDC · 500 USDC public in this wallet/);
    await h.keys('w'); // the only wrapper: straight to its Wrap screen
    expect(h.screen).toBe('wrap');
    let t = h.text();
    expect(t).toMatch(/Wrap USDC into cUSDC/);
    expect(t).toMatch(/USDC\s+500\s+public, in this wallet/);
    expect(t).toMatch(/cUSDC\s+1,250\.00\s+confidential/);
    expect(t).toMatch(/1 cUSDC = 1 USDC/);
    await h.keys('25');
    expect(h.text()).toMatch(/You get 25 cUSDC\./);
    await h.keys('{enter}');
    expect(h.screen).toBe('tx-review');
    t = h.text();
    expect(t).toMatch(/Wrap 25 USDC into 25 cUSDC/);
    expect(t).toMatch(/wrapped amount is public on-chain/);
    expect(t).toMatch(/Approve cUSDC to take exactly 25 USDC \(not unlimited\)/);
    expect(t).toMatch(/Wrap \(simulated after the approval\)/);
    expect(t).toMatch(/Simulation passed/);
    await confirm(h);
    expect(h.screen).toBe('home');
    t = h.text();
    expect(t).toMatch(/✔ Wrapped 25 USDC → 25 cUSDC/);
    expect(t).toMatch(/cUSDC 1,250 → 1,275/);
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
    expect(h.text()).toMatch(/You get 10 USDC \(public\)\./);
    await h.keys('{enter}');
    const t = h.text();
    expect(t).toMatch(/Unwrap 10 cUSDC into 10 USDC/);
    expect(t).toMatch(/unwrapped amount becomes public/);
    expect(t).toMatch(/Step 1\s+Request: burns 10 cUSDC/);
    expect(t).toMatch(/Step 2\s+Finish: publish the decrypted amount/);
    await confirm(h);
    expect(h.text()).toMatch(/✔ Unwrapped 10 cUSDC: 10 USDC arrived/);
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
    expect(h.text()).toMatch(/Step 1 done: 10 cUSDC → USDC\. Not decryptable yet/);
    await h.settle();
    expect(h.text()).toMatch(/Finish unwrap: 10 cUSDC → USDC\s+step 1 done, waiting to finish/);

    // Still not decryptable: the Review's check says so and nothing is sent.
    await h.keys('u');
    expect(h.text()).toMatch(/not decryptable yet/i);
    expect(listUnwraps({ open: true })[0].state).toBe('requested');

    // Decryption ready now.
    (h.backend as unknown as { opts: { fail?: string } }).opts.fail = undefined;
    await h.keys('{ctrl-c}', 'u');
    expect(h.screen).toBe('tx-review');
    expect(h.text()).toMatch(/Finish unwrap: 10 cUSDC → USDC/);
    expect(h.text()).toMatch(/You get\s+10 USDC/);
    await confirm(h);
    expect(h.text()).toMatch(/✔ Unwrapped 10 cUSDC: 10 USDC arrived/);
    await h.settle();
    expect(h.text()).not.toMatch(/Finish unwrap:/);
    expect(listUnwraps()[0]).toMatchObject({ state: 'finished' });
  });
});

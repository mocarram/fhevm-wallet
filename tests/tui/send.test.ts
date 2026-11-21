import { beforeEach, describe, expect, it } from 'vitest';
import { loadUiPrefs } from '../../src/storage/UiPrefsStore.js';
import { listTransactions } from '../../src/storage/TransactionStore.js';
import { nextTimeCommand } from '../../src/tui/flows/send.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { BOB, BOB_LOOKALIKE, Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

/** Home → Send → cUSDC → bob → amount → Review. */
async function toReview(h: Harness, amount = '25', expectReview = true) {
  await h.keys('s');
  expect(h.screen).toBe('send-token');
  await h.keys('{enter}');
  expect(h.screen).toBe('send-to');
  await h.keys('{enter}');
  expect(h.screen).toBe('send-amount');
  await h.keys(amount, '{enter}');
  if (expectReview) expect(h.screen).toBe('send-review');
}

describe('send wizard', () => {
  it('steps back with Esc through every step, keeping what was entered', async () => {
    const h = new Harness();
    await toReview(h, '12.5');
    expect(h.text()).toMatch(/● Review/);
    await h.keys('{escape}');
    expect(h.screen).toBe('send-amount');
    expect(h.text()).toMatch(/› 12\.5 +=/);
    await h.keys('{escape}');
    expect(h.screen).toBe('send-to');
    expect(h.s.send.to?.name).toBe('bob');
    await h.keys('{escape}');
    expect(h.screen).toBe('send-token');
    expect(h.s.send.token).toBeDefined();
    await h.keys('{escape}');
    expect(h.screen).toBe('home');
  });

  it('shows the exact value of friendly amounts and blocks more than the balance', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('b');
    await h.keys('{escape}');
    await h.keys('s', '{enter}', '{enter}', '1k');
    expect(h.text()).toMatch(/= 1,000 cUSDC/);
    await h.keys('{ctrl-u}', 'half');
    expect(h.text()).toMatch(/= 625 cUSDC/);
    await h.keys('{ctrl-u}', '5000', '{enter}');
    expect(h.screen).toBe('send-amount');
    expect(h.text()).toMatch(/more than your 1,250\./);
    expect(h.text()).toMatch(/would send 0 instead of failing/);
  });

  it('locked: Review asks to sign, unlocking returns to Review with fee and checks', async () => {
    const h = new Harness();
    await toReview(h);
    expect(h.text()).toMatch(/Confirm and sign/);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-sign');
    // No keystore on disk in this harness: a wrong password is reported on the field.
    await h.keys('nope', '{enter}');
    expect(h.screen).toBe('send-sign');
    expect(h.text()).toMatch(/did not unlock alice/);
  });

  it('unlocked: full send with countdown cancel, resend, pending, then confirmed', async () => {
    const h = new Harness({ unlocked: true });
    await toReview(h);
    expect(h.text()).toMatch(/Simulation passed/);
    expect(h.text()).toMatch(/Fee +≈ 0\.0003 ETH/);

    await h.keys('{enter}');
    expect(h.screen).toBe('send-count');
    expect(h.text()).toMatch(/Sending 25\.00 cUSDC to bob in 5/);
    await h.advance(2000);
    expect(h.text()).toMatch(/in 3…/);
    await h.keys('?', 'L', '0'); // ignored while counting down
    expect(h.screen).toBe('send-count');
    await h.keys('{escape}');
    expect(h.screen).toBe('send-review');
    expect(h.text()).toMatch(/Stopped\. Nothing was sent/);
    expect(h.ran).not.toContain('broadcast');

    await h.keys('{enter}');
    expect(h.screen).toBe('send-count');
    h.press(); // nothing
    h.now += 5000;
    const { tick } = await import('../../src/tui/app.js');
    const fx = tick(h.s, h.now);
    expect(fx.map((e) => e.kind)).toEqual(['broadcast']);
    // Right after the broadcast: Home, with the send pending in the status bar.
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/1 pending/);
    h.queue.push(...fx);
    await h.settle();
    expect(h.text()).not.toMatch(/1 pending/);
    expect(h.text()).toMatch(/✔ Sent 25\.00 cUSDC to bob/);
    expect(h.text()).toMatch(/Next time: fhew send bob 25 cusdc/);
    expect(h.text()).toMatch(/balance moved as expected/);
    expect(h.text()).toMatch(/cUSDC 1,225\.00/);

    // Sticky defaults and history are written, per network.
    const prefs = loadUiPrefs();
    expect(prefs.networks.sepolia.lastRecipient).toBe(BOB);
    expect(prefs.networks.sepolia.lastSend?.amount).toBe('25000000');
    expect(prefs.networks.mainnet.lastSend).toBeUndefined();
    expect(listTransactions({ walletAddress: h.signer.address, network: 'sepolia' })).toHaveLength(
      1,
    );

    // "." repeats it, stopping on Review with the whole draft filled in.
    expect(h.text()).toMatch(/↻ 25\.00 cUSDC → bob/);
    await h.keys('.');
    expect(h.screen).toBe('send-review');
    expect(h.text()).toMatch(/Repeating your last send/);
    expect(h.s.stack.map((f) => f.id)).toEqual([
      'home',
      'send-token',
      'send-to',
      'send-amount',
      'send-review',
    ]);
  });

  it('a prepared send is single-use: it never broadcasts twice', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.countdownSeconds = 0;
    await toReview(h);
    h.press('{enter}');
    expect(h.queue.filter((e) => e.kind === 'broadcast')).toHaveLength(1);
    expect(h.s.send.prepared).toBeUndefined();
    await h.settle();
  });

  it('Ctrl+C during the countdown goes Home without sending', async () => {
    const h = new Harness({ unlocked: true });
    await toReview(h);
    await h.keys('{enter}', '{ctrl-c}');
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/Nothing was sent/);
    await h.advance(10_000);
    expect(h.ran).not.toContain('broadcast');
  });
});

describe('recipient checks', () => {
  it('stops on a look-alike of a contact and offers the real contact', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}', 'p', BOB_LOOKALIKE, '{enter}');
    expect(h.screen).toBe('send-check');
    const t = h.text();
    expect(t).toMatch(/looks like your contact bob, but it is a different address/);
    expect(t).toMatch(/bob \(saved\)/);
    await h.keys('1');
    expect(h.screen).toBe('send-amount');
    expect(h.s.send.to).toMatchObject({ address: BOB, name: 'bob' });
  });

  it('using the look-alike anyway marks it in red on Review', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}', 'p', BOB_LOOKALIKE, '{enter}', '2', '1', '{enter}');
    expect(h.screen).toBe('send-review');
    expect(h.text()).toMatch(/You confirmed a look-alike address/);
    // Esc from Amount skips the look-alike stop and returns to the pasted address.
    await h.keys('{escape}', '{escape}');
    expect(h.screen).toBe('send-paste');
  });

  it('notes a first-time address, then offers to save it after the send', async () => {
    const h = new Harness({ unlocked: true });
    h.s.data.prefs.countdownSeconds = 0;
    await h.keys('s', '{enter}', 'p', STRANGER, '{enter}', '1', '{enter}');
    expect(h.text()).toMatch(/First time sending to this address/);
    await h.keys('{enter}');
    expect(h.text()).toMatch(/New address\. Press a to save it as a contact/);
    await h.keys('a');
    expect(h.screen).toBe('contact-name');
    await h.keys('carol', '{enter}');
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/Saved 0x6e1d…94fa as "carol"/);
    expect(h.s.offerSave).toBeNull();
  });

  it('rejects a mistyped checksum', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}', 'p', '0x91be4c2a6d0f83b1e7c5a9d2f4e8b0c6d3d207aF', '{enter}');
    expect(h.screen).toBe('send-paste');
    expect(h.s.fieldError?.[0]).toMatch(/checksum/i);
  });
});

describe('command bar send', () => {
  it(':send bob 25 cusdc opens Review with Esc walking back through the wizard', async () => {
    const h = new Harness();
    await h.keys(':send bob 25 cusdc{enter}');
    expect(h.screen).toBe('send-review');
    expect(h.text()).toMatch(/From the command bar/);
    expect(h.text()).toMatch(/Amount +25 cUSDC/);
    await h.keys('{escape}');
    expect(h.screen).toBe('send-amount');
    expect(h.s.inputs.amount).toBe('25');
  });

  it('explains unknown contacts and tokens', async () => {
    const h = new Harness();
    await h.keys(':send dave 25{enter}');
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/dave/);
    await h.keys(':send bob 25 cxyz{enter}');
    expect(h.text()).toMatch(/cxyz/);
  });

  it('a pasted address goes through the look-alike stop', async () => {
    const h = new Harness();
    await h.keys(`:send ${BOB_LOOKALIKE} 1{enter}`);
    expect(h.screen).toBe('send-check');
  });
});

describe('mainnet guard', () => {
  it('asks to retype the amount and always counts down', async () => {
    const h = new Harness({ unlocked: true });
    h.s.network = 'mainnet';
    h.s.data.prefs.countdownSeconds = 0;
    // Track cUSDC on mainnet for this test.
    h.s.data.tokens = [{ ...h.backend.catalogue('mainnet')[0] }];
    await toReview(h);
    expect(h.text()).toMatch(/MAINNET · real funds/);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-retype');
    await h.keys('24', '{enter}');
    expect(h.screen).toBe('send-retype');
    expect(h.s.fieldError?.[0]).toMatch(/doesn't match/);
    await h.keys('{ctrl-u}', '25', '{enter}');
    expect(h.screen).toBe('send-count');
    expect(h.s.countdown?.total).toBe(5);
  });
});

describe('send errors', () => {
  it('a failed simulation stops before signing, with cause, hint and details toggle', async () => {
    const h = new Harness({ unlocked: true, mock: { fail: 'simulate' } });
    await toReview(h, '25', false);
    expect(h.screen).toBe('send-error');
    let t = h.text();
    expect(t).toMatch(/Send stopped\. Nothing was signed or sent/);
    expect(t).toMatch(/Likely cause/);
    expect(t).toMatch(/What to try/);
    expect(t).not.toMatch(/Technical details/);
    await h.keys('2');
    t = h.text();
    expect(t).toMatch(/Technical details/);
    expect(t).toMatch(/Hide technical details/);
  });

  for (const fail of ['unconfirmed', 'reverted', 'replaced'] as const) {
    it(`${fail}: keeps the hash and explorer link and never offers to try again`, async () => {
      const h = new Harness({ unlocked: true, mock: { fail } });
      h.s.data.prefs.countdownSeconds = 0;
      await toReview(h);
      await h.keys('{enter}');
      expect(h.screen).toBe('home');
      expect(h.text()).toMatch(/Press e for details/);
      expect(h.text()).toMatch(/Do not send again until you have checked it/);
      await h.keys('e');
      expect(h.screen).toBe('send-error');
      const t = h.text();
      expect(t).toMatch(/handed to the network/);
      expect(t).toMatch(/Transaction +0x[0-9a-f]{64}/);
      expect(t).toMatch(/https:\/\/sepolia\.etherscan\.io\/tx\/0x/);
      expect(t).toMatch(/could pay twice/);
      expect(t).not.toMatch(/Try again|Back to review/);
    });
  }
});

describe('nextTimeCommand', () => {
  it('uses the contact name and token symbol when they are unambiguous', () => {
    const h = new Harness();
    const t = h.s.data.tokens[0];
    expect(nextTimeCommand(h.s, t, { address: BOB, name: 'bob', isNew: false }, 25_000_000n)).toBe(
      'fhew send bob 25 cusdc',
    );
    h.s.network = 'mainnet';
    expect(nextTimeCommand(h.s, t, { address: STRANGER, isNew: true }, 1_500_000n)).toBe(
      `fhew send ${STRANGER} 1.5 cusdc -n mainnet`,
    );
  });
});

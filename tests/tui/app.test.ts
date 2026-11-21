import { beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_SIZE, handleKey, isAnimating, render, tick } from '../../src/tui/app.js';
import { plain } from '../../src/tui/text.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness } from './harness.js';

beforeEach(() => wipeTestDataDir());

describe('Home and numbering', () => {
  it('shows the menu with stable numbers and Quit on 0', () => {
    const h = new Harness();
    const t = h.text();
    expect(t).toMatch(/1 {2}Balances/);
    expect(t).toMatch(/2 {2}Send/);
    expect(t).toMatch(/9 {2}Doctor/);
    expect(t).toMatch(/0 {2}Quit/);
  });

  it('keeps numbers stable when the unnumbered repeat item appears', () => {
    const h = new Harness();
    h.s.data.prefs.networks.sepolia.lastSend = {
      token: h.s.data.tokens[0].address,
      to: '0x91Be4C2a6d0f83B1e7c5a9d2f4E8b0C6D3d207AF',
      amount: '25000000',
    };
    const t = h.text();
    expect(t).toMatch(/↻ 25\.00 cUSDC → bob/);
    expect(t).toMatch(/1 {2}Balances/);
    expect(t).toMatch(/0 {2}Quit/);
  });

  it('opens screens by number and by letter', async () => {
    const h = new Harness();
    await h.keys('1');
    expect(h.screen).toBe('balances');
    await h.keys('{escape}', 'r');
    expect(h.screen).toBe('receive');
    await h.keys('{escape}', '8');
    expect(h.screen).toBe('settings');
  });

  it('0 quits from Home', async () => {
    const h = new Harness();
    await h.keys('0');
    expect(h.quitCalled).toBe(true);
  });

  it('warns once before quitting while a send is still confirming', async () => {
    const h = new Harness();
    h.s.pending.push({ id: 1, amountText: '1 cUSDC', toLabel: 'bob' });
    await h.keys('0');
    expect(h.quitCalled).toBe(false);
    expect(h.text()).toMatch(/still waiting for its confirmation/);
    await h.keys('0');
    expect(h.quitCalled).toBe(true);
  });
});

describe('Esc and Ctrl+C', () => {
  it('Esc goes back one screen; on Home it explains how to quit', async () => {
    const h = new Harness();
    await h.keys('6', '1');
    expect(h.screen).toBe('token-add');
    await h.keys('{escape}');
    expect(h.screen).toBe('tokens');
    await h.keys('{escape}', '{escape}');
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/already here/);
  });

  it('Ctrl+C returns to Home from deep inside, then twice on Home quits', async () => {
    const h = new Harness();
    await h.keys('6', '1');
    await h.keys('{ctrl-c}');
    expect(h.screen).toBe('home');
    // Nothing was in progress there: Home, without "Cancelled … Nothing was signed" (L4).
    expect(h.text()).not.toMatch(/Cancelled/);
    await h.keys('{ctrl-c}');
    expect(h.quitCalled).toBe(false);
    expect(h.text()).toMatch(/Ctrl\+C again to quit/);
    await h.keys('{ctrl-c}');
    expect(h.quitCalled).toBe(true);
  });

  it('another key between the two Ctrl+C presses disarms quitting', async () => {
    const h = new Harness();
    await h.keys('{ctrl-c}', '{down}', '{ctrl-c}');
    expect(h.quitCalled).toBe(false);
  });
});

describe('help, command bar and lock', () => {
  it('? opens help for the current screen; any key closes it', async () => {
    const h = new Harness();
    await h.keys('?');
    expect(h.text()).toMatch(/Keys on this screen/);
    expect(h.text()).toMatch(/Repeat your last send/);
    await h.keys('x');
    expect(h.s.help).toBe(false);
    expect(h.screen).toBe('home');
  });

  it(': opens the command bar, Esc closes it keeping the screen', async () => {
    const h = new Harness();
    await h.keys(':', 'bal');
    expect(h.text()).toMatch(/: bal/);
    await h.keys('{escape}');
    expect(h.s.cmd).toBeNull();
    expect(h.screen).toBe('home');
  });

  it(':balances navigates from anywhere, unknown commands explain themselves', async () => {
    const h = new Harness();
    await h.keys('6', ':balances{enter}');
    expect(h.s.stack.map((f) => f.id)).toEqual(['home', 'balances']);
    await h.keys(':frobnicate{enter}');
    expect(h.text()).toMatch(/Unknown command "frobnicate"/);
  });

  it('L locks and drops the key from memory', async () => {
    const h = new Harness({ unlocked: true });
    expect(h.text()).toMatch(/unlocked 15m/);
    await h.keys('L');
    expect(h.s.signer).toBeNull();
    expect(h.text()).toMatch(/locked/);
    expect(h.text()).toMatch(/Locked\. Your password is needed/);
  });

  it('auto-locks when the unlock time is over', async () => {
    const h = new Harness({ unlocked: true });
    await h.advance(15 * 60_000 + 1);
    expect(h.s.signer).toBeNull();
    expect(h.text()).toMatch(/Locked automatically/);
  });
});

describe('text fields', () => {
  it('printable keys type into the field instead of acting as shortcuts', async () => {
    const h = new Harness();
    await h.keys('6', '1', 'q0:?L');
    expect(h.screen).toBe('token-add');
    expect(h.s.inputs.tokenAddress).toBe('q0L');
    expect(h.s.cmd).toBeNull();
    expect(h.s.help).toBe(false);
    expect(h.quitCalled).toBe(false);
  });

  it('backspace and ctrl+u edit the field', async () => {
    const h = new Harness();
    await h.keys('6', '1', 'abc{backspace}');
    expect(h.s.inputs.tokenAddress).toBe('ab');
    await h.keys('{ctrl-u}');
    expect(h.s.inputs.tokenAddress).toBe('');
  });

  it('secret fields are masked and forgotten on Esc', async () => {
    const h = new Harness();
    await h.keys('1', '1');
    expect(h.screen).toBe('unlock');
    await h.keys('hunter22');
    expect(h.text()).toMatch(/\*{8}/);
    expect(h.text()).not.toMatch(/hunter22/);
    await h.keys('{escape}');
    expect(h.s.inputs.unlock).toBeUndefined();
  });
});

describe('render', () => {
  it('draws exactly rows lines of at most cols columns', () => {
    const h = new Harness();
    for (const size of [
      { cols: 100, rows: 40 },
      { cols: 40, rows: 10 },
      { cols: 20, rows: 5 },
    ]) {
      const lines = render(h.s, size).map(plain);
      expect(lines).toHaveLength(size.rows);
      for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(size.cols);
    }
  });

  it('treats a 0x0 terminal as 80x24 instead of drawing nothing', () => {
    const h = new Harness();
    const lines = render(h.s, { cols: 0, rows: 0 });
    expect(lines).toHaveLength(FALLBACK_SIZE.rows);
    expect(plain(lines[0])).toMatch(/fhEVM Wallet/);
  });

  it('keeps the cursor visible on a short terminal', async () => {
    const h = new Harness();
    await h.keys('{up}'); // wraps to Quit at the bottom
    const t = render(h.s, { cols: 80, rows: 10 }).map(plain).join('\n');
    expect(t).toMatch(/❯ 0 {2}Quit/);
  });

  it('wraps long lines instead of cutting links', () => {
    const h = new Harness();
    const url = 'https://sepolia.etherscan.io/tx/0x' + 'ab'.repeat(32);
    h.s.flash = [[{ t: `  ${url}` }]];
    const t = render(h.s, { cols: 60, rows: 30 }).map(plain).join('');
    expect(t.replace(/\s+/g, '')).toContain(url);
  });

  it('animates only while something is in progress', () => {
    const h = new Harness();
    expect(isAnimating(h.s)).toBe(false);
    h.s.decrypting = true;
    expect(isAnimating(h.s)).toBe(true);
  });
});

describe('robustness', () => {
  it('an unknown screen id shows an explanation and Esc recovers', () => {
    const h = new Harness();
    h.s.stack.push({ id: 'nope', cur: 0, params: {} });
    expect(h.text()).toMatch(/does not exist/);
    handleKey(h.s, 'escape');
    expect(h.screen).toBe('home');
  });

  it('ignores keys after quit', () => {
    const h = new Harness();
    h.s.quit = true;
    expect(handleKey(h.s, 'b')).toEqual([]);
    expect(tick(h.s, h.now)).toEqual([]);
  });
});

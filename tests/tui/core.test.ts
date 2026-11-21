import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/tui/commandParser.js';
import {
  moveCursor,
  multiSelectKey,
  picked,
  renderMenu,
  renderMultiSelect,
} from '../../src/tui/components/list.js';
import { describeError, errorLines, safeText } from '../../src/tui/errors.js';
import { normalizeKey } from '../../src/tui/keys.js';
import { indexForDigit, numbering, type MenuEntry } from '../../src/tui/screen.js';
import {
  countdownChoiceText,
  displayRpcUrl,
  unlockChoiceText,
} from '../../src/tui/screens/settings.js';
import { frame } from '../../src/tui/state.js';
import { clipLine, plain, toAnsi, wrapLine } from '../../src/tui/text.js';
import { WalletTxError } from '../../src/core/token/txErrors.js';

const noop = () => {};

describe('parseCommand', () => {
  it('parses send with and without token, and bare send', () => {
    expect(parseCommand('send bob 25 cusdc')).toEqual({
      type: 'send',
      to: 'bob',
      amount: '25',
      token: 'cusdc',
    });
    expect(parseCommand(':send bob 1k')).toMatchObject({ type: 'send', to: 'bob', amount: '1k' });
    expect(parseCommand('send')).toEqual({ type: 'send' });
    expect(parseCommand('send bob').type).toBe('error');
  });

  it('maps screen names, lock, help, quit and rejects the rest', () => {
    expect(parseCommand('Balances')).toEqual({ type: 'go', screen: 'balances' });
    expect(parseCommand('address book')).toEqual({ type: 'go', screen: 'contacts' });
    for (const s of ['receive', 'history', 'doctor', 'settings', 'wallets', 'tokens', 'contacts']) {
      expect(parseCommand(s).type).toBe('go');
    }
    expect(parseCommand('lock')).toEqual({ type: 'lock' });
    expect(parseCommand('help')).toEqual({ type: 'help' });
    expect(parseCommand('quit')).toEqual({ type: 'quit' });
    expect(parseCommand('   ')).toEqual({ type: 'none' });
    expect(parseCommand('rm -rf')).toMatchObject({ type: 'error' });
  });
});

describe('normalizeKey', () => {
  it('names special keys and passes printable characters', () => {
    expect(normalizeKey(undefined, { name: 'return' })).toBe('enter');
    expect(normalizeKey('\x1b', { name: 'escape' })).toBe('escape');
    expect(normalizeKey('\x03', { name: 'c', ctrl: true })).toBe('ctrl-c');
    expect(normalizeKey('a', { name: 'a' })).toBe('a');
    expect(normalizeKey('L', { name: 'l', shift: true })).toBe('L');
    expect(normalizeKey(' ', { name: 'space' })).toBe(' ');
  });

  it('drops control characters and unbound ctrl/meta keys', () => {
    expect(normalizeKey('\x07', {})).toBeNull();
    expect(normalizeKey('\x1b[31m', {})).toBeNull();
    expect(normalizeKey('x', { name: 'x', ctrl: true })).toBeNull();
    expect(normalizeKey('x', { name: 'x', meta: true })).toBeNull();
  });
});

describe('numbering', () => {
  const items: MenuEntry[] = [
    { label: 'repeat', nonum: true, act: noop },
    { label: 'A', act: noop },
    { sep: true },
    { label: 'B', act: noop },
    { label: 'Quit', zero: true, act: noop },
  ];

  it('numbers ordinary items 1..9, Quit 0, skips unnumbered ones', () => {
    expect(numbering(items)).toEqual([null, 1, null, 2, 0]);
    expect(indexForDigit(items, 2)).toBe(3);
    expect(indexForDigit(items, 0)).toBe(4);
    expect(indexForDigit(items, 7)).toBe(-1);
  });

  it('moves over separators and wraps', () => {
    expect(moveCursor(items, 1, 1)).toBe(3);
    expect(moveCursor(items, 4, 1)).toBe(0);
    expect(moveCursor(items, 0, -1)).toBe(4);
  });

  it('draws the cursor and numbers', () => {
    const { lines, cursorLine } = renderMenu(items, 3, 80);
    expect(cursorLine).toBe(3);
    expect(plain(lines[3])).toMatch(/❯ 2 {2}B/);
    expect(plain(lines[4])).toMatch(/0 {2}Quit/);
    expect(plain(lines[0])).toMatch(/^ {6}repeat/);
  });
});

describe('multi-select list', () => {
  const options = [
    { id: 'a1', label: 'cUSDC' },
    { id: 'b2', label: 'cDAI' },
    { id: 'c3', label: 'cTEST', note: 'unverified' },
  ];

  it('Space toggles, a selects all then none, Enter confirms in list order', () => {
    const f = frame('x');
    expect(multiSelectKey(f, options, ' ').kind).toBe('toggled');
    multiSelectKey(f, options, 'down');
    multiSelectKey(f, options, 'down');
    multiSelectKey(f, options, ' ');
    expect(multiSelectKey(f, options, 'enter')).toEqual({ kind: 'confirm', ids: ['a1', 'c3'] });
    multiSelectKey(f, options, 'a');
    expect([...picked(f)]).toEqual(['a1', 'b2', 'c3']);
    multiSelectKey(f, options, 'a');
    expect(picked(f).size).toBe(0);
    expect(multiSelectKey(f, options, 'x').kind).toBe('ignored');
  });

  it('renders boxes and notes', () => {
    const f = frame('x');
    multiSelectKey(f, options, ' ');
    const lines = renderMultiSelect(f, options).map(plain);
    expect(lines[0]).toMatch(/❯ \[x\] cUSDC/);
    expect(lines[2]).toMatch(/\[ \] cTEST +unverified/);
  });
});

describe('text', () => {
  it('clips with an ellipsis and wraps without losing characters', () => {
    expect(plain(clipLine([{ t: 'abcdefgh' }], 5))).toBe('abcd…');
    const long = 'word '.repeat(30).trim();
    const rows = wrapLine([{ t: long, s: ['dim'] }], 40);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(plain(r).length).toBeLessThanOrEqual(40);
    expect(rows.map(plain).join(' ').replace(/\s+/g, ' ').trim()).toBe(long);
  });

  it('emits colour only when asked, but keeps the selection visible', () => {
    expect(toAnsi([{ t: 'x', s: ['red'] }], false)).toBe('x');
    expect(toAnsi([{ t: 'x', s: ['red'] }], true)).toBe('\x1b[31mx\x1b[0m');
    expect(toAnsi([{ t: 'x', s: ['sel'] }], false)).toBe('\x1b[7mx\x1b[0m');
  });
});

describe('describeError', () => {
  it('keeps a wallet error title, cause and hint', () => {
    const d = describeError(new WalletTxError('UNKNOWN', 'Title.', 'Cause.', 'Hint.', 'raw'));
    expect(d).toMatchObject({ title: 'Title.', cause: 'Cause.', hint: 'Hint.', raw: 'raw' });
  });

  it('translates ethers errors instead of showing their message', () => {
    const err = Object.assign(new Error('could not detect network (url=https://x.io/v3/abc)'), {
      code: 'NETWORK_ERROR',
      shortMessage: 'could not detect network',
    });
    const d = describeError(err, { action: 'decrypt' });
    expect(d.title).toMatch(/^Could not reach the network\./);
    expect(d.title).not.toContain('abc');
    expect(d.code).toBe('RPC_UNAVAILABLE');
  });

  it('redacts keys, masks URL paths and strips escapes from other errors', () => {
    const err = new Error(
      'failed https://eth.example.com/v3/0123456789abcdef0123 \x1b[31mred\nsecond line',
    );
    const d = describeError(err);
    expect(d.title).not.toContain('0123456789abcdef0123');
    expect(d.title).not.toContain('\x1b');
    expect(d.title).not.toContain('second line');
    expect(d.title).toContain('https://eth.example.com');
    expect(safeText('privateKey: 0x' + 'a'.repeat(64))).not.toMatch(/a{64}/);
  });

  it('masks pieces of the configured RPC URL through the shared CLI redaction', () => {
    const before = process.env.SEPOLIA_RPC_URL;
    process.env.SEPOLIA_RPC_URL = 'https://rpc.example.org/k/Zq8sTokenPiece77';
    try {
      const d = describeError(new Error('boom near Zq8sTokenPiece77 here'));
      expect(d.title).not.toContain('Zq8sTokenPiece77');
      expect(d.raw).not.toContain('Zq8sTokenPiece77');
    } finally {
      if (before === undefined) delete process.env.SEPOLIA_RPC_URL;
      else process.env.SEPOLIA_RPC_URL = before;
    }
  });

  it('falls back for non-errors and renders lines', () => {
    expect(describeError(undefined).title).toBe('Something went wrong.');
    expect(plain(errorLines(new Error('boom'))[0])).toBe('  ✗ boom');
  });
});

describe('settings helpers', () => {
  it('words the choices and hides RPC paths', () => {
    expect(unlockChoiceText(0)).toBe('every action');
    expect(unlockChoiceText(60)).toBe('1 hour');
    expect(unlockChoiceText(15)).toBe('15 min');
    expect(countdownChoiceText(0)).toBe('off');
    expect(displayRpcUrl('https://eth.example.com/v3/secretkey')).toBe('https://eth.example.com/…');
    expect(displayRpcUrl('https://user:pw@rpc.example.com')).toBe('https://rpc.example.com');
    expect(displayRpcUrl('nonsense')).toBe('custom URL');
  });
});

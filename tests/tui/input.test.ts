import { beforeEach, describe, expect, it } from 'vitest';
import { coalesceBurst, InputParser, isBurst, type InputEvent } from '../../src/tui/input.js';
import { handleKey } from '../../src/tui/app.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { BOB, BOB_LOOKALIKE, Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

const keys = (ev: InputEvent[]) => ev.map((e) => (e.kind === 'key' ? e.key : `[paste:${e.text}]`));

describe('InputParser', () => {
  it('reports a lone Esc only once nothing follows, without readline’s 500 ms wait', () => {
    const p = new InputParser();
    expect(p.feed('\x1b')).toEqual([]);
    expect(p.pending).toBe(true);
    expect(p.waitMs()).toBeLessThanOrEqual(50);
    expect(keys(p.flush())).toEqual(['escape']);
    expect(p.pending).toBe(false);
  });

  it('turns Esc followed by a key into Esc then the key (Esc+s is not lost)', () => {
    const p = new InputParser();
    expect(keys(p.feed('\x1bs'))).toEqual(['escape', 's']);
    expect(keys(p.feed('\x1b'))).toEqual([]);
    expect(keys(p.feed('h'))).toEqual(['escape', 'h']);
    expect(keys(p.feed('\x1b\x1b'))).toEqual(['escape']);
    expect(keys(p.flush())).toEqual(['escape']);
  });

  it('names arrows, paging keys, Enter, Backspace and the bound Ctrl keys', () => {
    const p = new InputParser();
    expect(
      keys(
        p.feed('\x1b[A\x1b[B\x1bOC\x1b[D\x1b[5~\x1b[6~\x1b[H\x1b[4~\x1b[1;5A\r\n\x7f\x03\x15\t'),
      ),
    ).toEqual([
      'up',
      'down',
      'right',
      'left',
      'pageup',
      'pagedown',
      'home',
      'end',
      'up',
      'enter',
      'backspace',
      'ctrl-c',
      'ctrl-u',
      'tab',
    ]);
  });

  it('keeps a sequence split across reads together and drops unknown ones', () => {
    const p = new InputParser();
    expect(keys(p.feed('\x1b['))).toEqual([]);
    expect(keys(p.feed('B'))).toEqual(['down']);
    expect(keys(p.feed('\x1b[15~x\x01\x1b[Z'))).toEqual(['x']); // F5, Ctrl+A, Shift+Tab
    expect(keys(p.feed('é€'))).toEqual(['é', '€']);
  });

  it('makes a bracketed paste one event, even when split and holding escape codes', () => {
    const p = new InputParser();
    expect(keys(p.feed('\x1b[200~0x91Be'))).toEqual([]);
    expect(p.pending).toBe(true);
    expect(keys(p.feed('4C2a\x1b[201'))).toEqual([]);
    expect(keys(p.feed('~q'))).toEqual(['[paste:0x91Be4C2a]', 'q']);
    expect(keys(p.feed('\x1b[200~a\x1b[Ab\x1b[201~'))).toEqual(['[paste:a\x1b[Ab]']);
  });

  it('ends a paste whose end marker never arrives once input goes quiet', () => {
    const p = new InputParser();
    p.feed('\x1b[200~hello');
    expect(keys(p.flush())).toEqual(['[paste:hello]']);
    expect(p.pending).toBe(false);
  });

  it('treats an unbracketed burst that is exactly one address as a paste', () => {
    const p = new InputParser();
    const ev = p.feed(BOB);
    expect(isBurst(ev)).toBe(true);
    expect(keys(coalesceBurst(ev))).toEqual([`[paste:${BOB}]`]);
    expect(keys(coalesceBurst(p.feed('alice\r')))).toEqual(['a', 'l', 'i', 'c', 'e', 'enter']);
    expect(isBurst(p.feed('s'))).toBe(false);
  });
});

describe('paste in the TUI', () => {
  it('ignores a paste on Home instead of running it as shortcuts (a 0 used to quit)', async () => {
    const h = new Harness();
    await h.paste('0x0481911Ea44577a5290903Ea126f40689120604e').settle();
    expect(h.quitCalled).toBe(false);
    expect(h.screen).toBe('home');
    expect(h.text()).toMatch(/Pasted address ignored/);
    expect(h.text()).toMatch(/Send \(s\), then Paste an address \(p\)/);
  });

  it('a quit key inside a burst of keys only arms quitting', () => {
    const h = new Harness();
    expect(handleKey(h.s, '0', { burst: true })).toEqual([]);
    expect(h.text()).toMatch(/Press 0 again to quit/);
    expect(handleKey(h.s, '0', { burst: true }).map((e) => e.kind)).toEqual(['quit']);
  });

  it('routes a pasted address on Send › Recipient to the paste step, filled in', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}');
    expect(h.screen).toBe('send-to');
    await h.paste(`  ${STRANGER}\n`).settle();
    expect(h.screen).toBe('send-paste');
    expect(h.s.inputs.paste).toBe(STRANGER);
    // Nothing was submitted: the paste never acts as Enter.
    await h.keys('{enter}');
    expect(h.screen).toBe('send-amount');
    expect(h.s.send.to).toMatchObject({ address: STRANGER, isNew: true });
  });

  it('still stops a pasted look-alike of a contact', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}');
    await h.paste(BOB_LOOKALIKE).settle();
    await h.keys('{enter}');
    expect(h.screen).toBe('send-check');
    expect(h.text()).toMatch(/looks like your contact bob/);
  });

  it('types a paste into the focused field with its rules, masked for secrets', async () => {
    const h = new Harness();
    await h.keys('s', '{enter}', 'p');
    await h.paste(`${BOB}xyz`).settle(); // max 42 characters
    expect(h.s.inputs.paste).toBe(BOB);
    await h.keys('{escape}', '{escape}', '{escape}', '{escape}', 'b', '{enter}');
    expect(h.screen).toBe('unlock');
    await h.paste(' pass word \n').settle();
    expect(h.s.inputs.unlock).toBe(' pass word ');
    expect(h.text()).not.toMatch(/pass word/);
    await h.keys('{escape}');
    expect(h.s.inputs.unlock).toBeUndefined();
  });

  it('pastes into the command bar and the list filter', async () => {
    const h = new Harness();
    await h.keys(':');
    await h.paste('send bob 1 cusdc').settle();
    expect(h.s.cmd).toBe('send bob 1 cusdc');
    await h.keys('{escape}');
    await h.keys('7', '/');
    await h.paste('bo\n').settle();
    expect(h.s.inputs['filter.contacts']).toBe('bo');
    expect(h.screen).toBe('contacts');
  });

  it('a pasted address on Address book starts Add contact with the address filled', async () => {
    const h = new Harness();
    await h.keys('7');
    await h.paste(STRANGER).settle();
    expect(h.screen).toBe('contact-name');
    await h.keys('carol', '{enter}');
    expect(h.screen).toBe('contact-address');
    await h.keys('{enter}');
    expect(h.s.data.contacts.some((c) => c.name === 'carol')).toBe(true);
  });
});

describe('InputParser edge cases', () => {
  it('Esc typed just before O or [ keeps both keys once input goes quiet', () => {
    const p = new InputParser();
    expect(p.feed('\x1bO')).toEqual([]);
    expect(keys(p.flush())).toEqual(['escape', 'O']);
  });
});

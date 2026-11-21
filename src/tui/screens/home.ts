/**
 * Home: low-gas nudge, balances with their age, then the main menu.
 * `↻ repeat last send` (key `.`) and "save new address" (key `a`) are unnumbered so the
 * numbers of the other items never move.
 */

import { formatBalance } from '../../core/send/amount.js';
import { QUIT } from '../effects.js';
import { age, formatEth, isLowGas, sendsLeft, spinner } from '../format.js';
import { open } from '../nav.js';
import type { MenuEntry, ScreenDef } from '../screen.js';
import { isUnlocked, type AppState } from '../state.js';
import { dimLine, line, lineWidth, seg, type Line } from '../text.js';
import { lastSendSummary, repeatLastSend, startSend } from '../flows/send.js';
import { shortAddress } from '../../core/send/recipient.js';
import { SEP } from './common.js';

/** Most rows of balances on Home; the rest are counted ("+12 more") and on Balances. */
const HOME_BALANCE_ROWS = 2;

/**
 * The balances strip on Home: each token's cached or decrypted value with its age, on
 * at most two rows of `cols` columns. Entries are never split across rows; tokens that
 * do not fit are counted in "+N more · b Balances" so the menu stays on screen.
 */
export function balancesLines(s: AppState, cols = s.size.cols): Line[] {
  if (s.data.tokens.length === 0) {
    return [[seg('  No tokens tracked yet. Add one in Tokens.', 'dim')]];
  }
  let oldest: number | undefined;
  let anySession = false;
  let anyMissing = false;
  const entries: Line[] = s.data.tokens.map((t) => {
    const out: Line = [seg(`${t.symbol} `, 'dim')];
    const b = s.balances[t.address.toLowerCase()];
    const refreshing = Boolean(s.refreshing[t.address.toLowerCase()]);
    if (b) {
      out.push(seg(formatBalance(b.value, t.decimals), 'bold'));
      // A background re-decrypt keeps the old value on screen with a spinner beside it.
      if (refreshing) out.push(seg(` ${spinner(s.now)}`, 'cyan'));
      if (b.source === 'session') anySession = true;
      if (b.at !== undefined) oldest = oldest === undefined ? b.at : Math.min(oldest, b.at);
    } else if (refreshing) {
      out.push(seg(`${spinner(s.now)} decrypting`, 'cyan'));
    } else {
      out.push(seg('locked', 'dim'));
      anyMissing = true;
    }
    return out;
  });
  let tail: string;
  const shownAge = oldest !== undefined || anySession ? age(oldest, s.now) : '';
  if (s.decrypting) tail = shownAge ? `${shownAge} · updating…` : 'updating…';
  else if (anySession && isUnlocked(s)) tail = `decrypted ${shownAge}`;
  else if (shownAge) tail = `cached ${shownAge} · unlock to refresh`;
  else if (anyMissing) tail = 'unlock to decrypt';
  else tail = '';
  const tailSeg = tail ? seg(`   · ${tail}`, 'dim') : seg('');

  const gap = '   ';
  const room = Math.max(20, cols - 2);
  const rows: Line[] = [];
  let row: Line = [];
  let used = 0;
  let i = 0;
  for (; i < entries.length; i++) {
    const w = lineWidth(entries[i]) + (row.length ? gap.length : 0);
    if (row.length && used + w > room) {
      if (rows.length + 1 >= HOME_BALANCE_ROWS) break;
      rows.push(row);
      row = [];
      used = 0;
      i--;
      continue;
    }
    if (row.length) row.push(seg(gap, 'dim'));
    row.push(...entries[i]);
    used += w;
  }
  if (i < entries.length) {
    // Make room on the last row for the count of the tokens left out.
    const more = (n: number) => `${gap}+${n} more · b Balances`;
    while (row.length > 2 && used + more(entries.length - i).length > room) {
      i--;
      used -= lineWidth(entries[i]) + gap.length;
      row = row.slice(0, row.length - entries[i].length - 1);
    }
    row.push(seg(more(entries.length - i), 'dim'));
    used += more(entries.length - i).length;
  }
  if (used + lineWidth([tailSeg]) <= room) row.push(tailSeg);
  rows.push(row);
  if (tail && !row.includes(tailSeg)) rows.push([seg(`· ${tail}`, 'dim')]);
  return rows.map((r) => [seg('  '), ...r]);
}

export const homeScreen: ScreenDef = {
  crumb: [],
  view: (s) => {
    const body: Line[] = [];
    if (isLowGas(s)) {
      body.push(
        line(
          '  ',
          seg(
            `! Low on gas: ${formatEth(s.eth!.wei)} ETH covers about ${sendsLeft(s.eth!.wei)} more sends.`,
            'yellow bold',
          ),
        ),
        dimLine(
          s.network === 'sepolia'
            ? '    Get free Sepolia ETH: Receive › Get test ETH shows faucet links and your address.'
            : '    Send some ETH to this wallet to pay network fees.',
        ),
        line(''),
      );
    }
    body.push(...balancesLines(s));

    const items: MenuEntry[] = [];
    if (s.lastSendError) {
      items.push({
        label: 'What happened to the last send',
        key: 'e',
        nonum: true,
        valueStyle: 'yellow',
        value: 'check',
        act: (st) => {
          st.errorView = st.lastSendError;
          return open(st, 'send-error', { from: 'home' });
        },
      });
    }
    if (s.offerSave) {
      const address = s.offerSave;
      items.push({
        label: `Save ${shortAddress(address)} as a contact`,
        key: 'a',
        nonum: true,
        value: 'new',
        valueStyle: 'yellow',
        act: (st) => {
          delete st.inputs.contactName;
          return open(st, 'contact-name', { address });
        },
      });
    }
    const last = lastSendSummary(s);
    if (last) {
      items.push({
        label: last,
        key: '.',
        nonum: true,
        note: 'repeat last send',
        act: repeatLastSend,
      });
    }
    items.push(
      { label: 'Balances', key: 'b', act: (st) => open(st, 'balances') },
      { label: 'Send', key: 's', act: startSend },
      { label: 'Receive', key: 'r', act: (st) => open(st, 'receive') },
      { label: 'History', key: 'h', act: (st) => open(st, 'history') },
      SEP,
      { label: 'Wallets', act: (st) => open(st, 'wallets') },
      { label: 'Tokens', act: (st) => open(st, 'tokens') },
      { label: 'Address book', act: (st) => open(st, 'contacts') },
      { label: 'Settings', act: (st) => open(st, 'settings') },
      { label: 'Doctor', key: 'd', note: 'check your setup', act: (st) => open(st, 'doctor') },
      SEP,
      { label: 'Quit', key: 'q', zero: true, act: () => [QUIT] },
    );
    return {
      body,
      items,
      hint: '↑↓ move · enter select · : command · ? help · L lock · 0 quit',
      help: [
        ['b s r h d', 'Balances, Send, Receive, History, Doctor'],
        ['.', 'Repeat your last send'],
        ['a', 'Save the last new address (when offered)'],
        ['0 / q', 'Quit'],
      ],
    };
  },
};

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
import { dimLine, line, seg, type Line } from '../text.js';
import { lastSendSummary, repeatLastSend, startSend } from '../flows/send.js';
import { shortAddress } from '../../core/send/recipient.js';
import { SEP } from './common.js';

/** The balances line on Home. */
export function balancesLine(s: AppState): Line {
  const out: Line = [seg('  ')];
  if (s.data.tokens.length === 0) {
    return [seg('  No tokens tracked yet. Add one in Tokens.', 'dim')];
  }
  let oldest: number | undefined;
  let anySession = false;
  let anyMissing = false;
  s.data.tokens.forEach((t, i) => {
    if (i) out.push(seg('   ', 'dim'));
    out.push(seg(`${t.symbol} `, 'dim'));
    const b = s.balances[t.address.toLowerCase()];
    if (s.decrypting && (!b || b.source === 'cache')) {
      out.push(seg(`${spinner(s.now)} decrypting`, 'cyan'));
    } else if (b) {
      out.push(seg(formatBalance(b.value, t.decimals), 'bold'));
      if (b.source === 'session') anySession = true;
      if (b.at !== undefined) oldest = oldest === undefined ? b.at : Math.min(oldest, b.at);
    } else {
      out.push(seg('locked', 'dim'));
      anyMissing = true;
    }
  });
  let tail: string;
  if (s.decrypting) tail = 'updating…';
  else if (anySession && isUnlocked(s)) tail = `decrypted ${age(oldest, s.now)}`;
  else if (oldest !== undefined || anySession)
    tail = `cached ${age(oldest, s.now)} · unlock to refresh`;
  else if (anyMissing) tail = 'unlock to decrypt';
  else tail = '';
  if (tail) out.push(seg(`   · ${tail}`, 'dim'));
  return out;
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
    body.push(balancesLine(s));

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

/**
 * Balances (ETH and every tracked token) and the Unlock screen.
 */

import { formatBalance } from '../../core/send/amount.js';
import { shortAddress } from '../../core/send/recipient.js';
import { age, formatEth, isLowGas } from '../format.js';
import { decryptAll } from '../flows/data.js';
import { startSend } from '../flows/send.js';
import { unlock } from '../flows/wallet.js';
import { open } from '../nav.js';
import type { ScreenDef } from '../screen.js';
import { isUnlocked, type AppState } from '../state.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import { backItem, BLANK, inputLine } from './common.js';

function unlockMinutesText(s: AppState): string {
  const m = s.data.prefs.unlockMinutes;
  return m === 0 ? 'Locks again after this action.' : `Stays unlocked for ${m} min.`;
}

export const balancesScreen: ScreenDef = {
  crumb: ['Balances'],
  view: (s) => {
    const body: Line[] = [
      dimLine('  Token      Balance             Contract'),
      dimLine('  ─────────────────────────────────────────────────'),
      line(
        '  ',
        seg(pad('ETH', 9), 'bold'),
        '  ',
        seg(pad(s.eth ? formatEth(s.eth.wei) : '…', 18), isLowGas(s) ? 'yellow' : ''),
        '  ',
        seg('native · pays gas', 'dim'),
      ),
    ];
    for (const t of s.data.tokens) {
      const b = s.balances[t.address.toLowerCase()];
      const shown = b
        ? formatBalance(b.value, t.decimals)
        : s.decrypting
          ? 'decrypting…'
          : 'locked';
      body.push(
        line(
          '  ',
          seg(pad(t.symbol, 9), 'bold'),
          '  ',
          seg(pad(shown, 18), b?.source === 'session' ? 'green' : 'dim'),
          '  ',
          seg(shortAddress(t.address), 'dim'),
        ),
      );
    }
    if (s.data.tokens.length === 0) body.push(dimLine('  No tokens tracked. Add one in Tokens.'));
    body.push(BLANK);
    const sessionAges = Object.values(s.balances).filter((b) => b.source === 'session');
    if (isUnlocked(s) && sessionAges.length) {
      const newest = Math.max(...sessionAges.map((b) => b.at ?? 0));
      body.push(dimLine(`  ✔ ${sessionAges.length} token(s) decrypted · ${age(newest, s.now)}`));
    } else if (!isUnlocked(s)) {
      const cached = Object.values(s.balances).filter((b) => b.source === 'cache');
      const oldest = cached.length ? Math.min(...cached.map((b) => b.at ?? 0)) : undefined;
      body.push(
        line(
          seg(
            cached.length
              ? `  Locked. These are cached values from ${age(oldest || undefined, s.now)}.`
              : '  Locked. Unlock to decrypt your balances.',
            'yellow',
          ),
        ),
      );
    }
    const items = isUnlocked(s)
      ? [
          { label: 'Refresh', act: (st: AppState) => decryptAll(st, true) },
          { label: 'Send from this wallet', act: startSend },
          backItem(),
        ]
      : [
          {
            label: 'Unlock and refresh',
            act: (st: AppState) => {
              delete st.inputs.unlock;
              return open(st, 'unlock');
            },
          },
          backItem(),
        ];
    return {
      body,
      items,
      hint: '↑↓ move · enter select · esc back',
      help: [['enter', 'Refresh, or unlock to decrypt']],
    };
  },
};

export const unlockScreen: ScreenDef = {
  crumb: ['Balances', 'Unlock'],
  view: (s) => {
    const spec = { field: 'unlock', secret: true, placeholder: 'your wallet password' };
    return {
      body: [
        line('  Password for ', seg(s.wallet?.name ?? '', 'bold')),
        BLANK,
        inputLine(s, spec),
        BLANK,
        dimLine(`  ${unlockMinutesText(s)} The key is kept in memory only.`),
      ],
      input: spec,
      items: [{ label: 'Unlock', act: (st) => unlock(st, 'balances') }, backItem()],
      hint: 'type password · enter unlock · esc back',
    };
  },
};

export { unlockMinutesText };

/**
 * History: pending sends first, then local and synced transfers. Confidential amounts of
 * incoming transfers stay "encrypted" until Phase 4 adds history decryption.
 */

import { loadHistory } from '../flows/manage.js';
import { spinner } from '../format.js';
import type { ScreenDef } from '../screen.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import { backItem, BLANK } from './common.js';
import { matchesFilter } from '../components/list.js';

const HISTORY_FILTER = 'filter.history';

export const historyScreen: ScreenDef = {
  crumb: ['History'],
  onEnter: loadHistory,
  view: (s) => {
    const body: Line[] = [
      dimLine('  When          Type       Amount              Token    With'),
      dimLine('  ───────────────────────────────────────────────────────────────'),
    ];
    for (const p of s.pending) {
      body.push(
        line(
          '  ',
          pad('now', 12),
          '  ',
          pad('sending', 9),
          '  ',
          seg(pad(`-${p.amountText}`, 27), 'yellow'),
          ' ',
          pad(p.toLabel, 13),
          seg(`${spinner(s.now)} pending`, 'yellow'),
        ),
      );
    }
    // `/` filter (Phase 4a): kind, token, counterparty, amount or hash.
    const rows = (s.history?.rows ?? []).filter((r) =>
      matchesFilter(
        `${r.kind} ${r.token} ${r.counterparty} ${r.amount} ${r.txHash}`,
        s.inputs[HISTORY_FILTER],
      ),
    );
    for (const r of rows) {
      body.push(
        line(
          '  ',
          pad(r.when, 12),
          '  ',
          pad(r.kind, 9),
          '  ',
          seg(
            pad(r.amount, 18),
            r.amount.startsWith('+') ? 'green' : r.amount.startsWith('-') ? 'yellow' : 'dim',
          ),
          '  ',
          pad(r.token, 7),
          '  ',
          r.counterparty,
        ),
      );
    }
    if (!rows.length && !s.pending.length && !s.history?.loading)
      body.push(dimLine('  No transfers yet.'));
    body.push(BLANK);
    if (s.history?.loading)
      body.push(line('  ', seg(`${spinner(s.now)} Syncing with the network…`, 'cyan')));
    else if (s.history?.error) body.push(line('  ', seg(s.history.error, 'yellow')));
    body.push(
      dimLine(
        '  Incoming confidential amounts show as "encrypted"; decrypting them is coming in a later update.',
      ),
    );
    return {
      body,
      filter: HISTORY_FILTER,
      items: [
        {
          label: 'Show latest in explorer',
          act: (st) => {
            const first = st.history?.rows[0];
            st.flash = first
              ? [line(seg(`  → ${explorerFor(st.network, first.txHash)}`, 'cyan'))]
              : [dimLine('  Nothing to show yet.')];
          },
        },
        { label: 'Refresh', act: loadHistory },
        backItem(),
      ],
      hint: '↑↓ move · enter select · esc back',
      help: [['enter', 'Open the latest transfer, refresh or go back']],
    };
  },
};

function explorerFor(network: string, txHash: string): string {
  return `${network === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'}/tx/${txHash}`;
}

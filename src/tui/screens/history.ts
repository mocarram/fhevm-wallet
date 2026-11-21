/**
 * History: pending sends first, then local and synced transfers. Confidential amounts
 * are decrypted in the background once the wallet is unlocked (one signature for all);
 * amounts this wallet may not decrypt stay "encrypted".
 */

import { loadHistory } from '../flows/manage.js';
import { decryptHistory, hasEncryptedRows } from '../flows/history.js';
import { open } from '../nav.js';
import { isUnlocked, type AppState } from '../state.js';
import type { Item } from '../screen.js';
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
    // Newest first (pending sends, then by block); the rows scroll with PgUp/PgDn while
    // the header, the notes and the menu stay on screen.
    const list: Line[] = [];
    for (const p of s.pending) {
      list.push(
        line(
          '  ',
          pad('now', 12),
          '  ',
          pad('sending', 9),
          '  ',
          seg(pad(p.label ?? `-${p.amountText}`, 27), 'yellow'),
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
      list.push(
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
          ...(r.disclosed ? [seg('  public', 'dim')] : []),
        ),
      );
    }
    if (!rows.length && !s.pending.length && !s.history?.loading)
      body.push(dimLine('  No transfers yet.'));
    const after: Line[] = [BLANK];
    if (s.history?.loading)
      after.push(line('  ', seg(`${spinner(s.now)} Syncing with the network…`, 'cyan')));
    else if (s.history?.error) after.push(line('  ', seg(s.history.error, 'yellow')));
    if (s.history?.decrypting)
      after.push(line('  ', seg(`${spinner(s.now)} Decrypting amounts…`, 'cyan')));
    else if (hasEncryptedRows(s))
      after.push(
        dimLine(
          isUnlocked(s)
            ? '  "encrypted": this wallet is not allowed to decrypt that amount.'
            : '  Unlock to decrypt the "encrypted" amounts (one signature for all of them).',
        ),
      );
    const decryptItem: Item[] = hasEncryptedRows(s)
      ? [
          {
            label: 'Decrypt amounts',
            act: (st: AppState) => {
              if (isUnlocked(st)) return decryptHistory(st);
              delete st.inputs.unlock;
              return open(st, 'unlock', { after: 'history' });
            },
          },
        ]
      : [];
    const discloseItem: Item[] = (s.history?.rows ?? []).some((r) => r.handle)
      ? [{ label: 'Disclose an amount', act: (st: AppState) => open(st, 'disclose-pick') }]
      : [];
    return {
      body,
      list,
      after,
      filter: HISTORY_FILTER,
      items: [
        ...decryptItem,
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
        ...discloseItem,
        backItem(),
      ],
      hint: '↑↓ move · enter select · / filter · pgup/pgdn scroll · esc back',
      help: [
        ['enter', 'Decrypt amounts, open the latest transfer, refresh, disclose or go back'],
        ['/', 'Filter by type, token, address, amount or hash'],
      ],
    };
  },
};

function explorerFor(network: string, txHash: string): string {
  return `${network === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'}/tx/${txHash}`;
}

/**
 * History rows and their decrypted amounts.
 *
 * Confidential transfers carry only an amount handle. Once the wallet is unlocked the
 * amounts are decrypted in the background with the session's single signature and
 * cached by handle (owner-only storage), so later visits show them without unlocking.
 * Amounts this wallet may not decrypt stay "encrypted" without an error.
 */

import { parseUnits } from 'ethers';
import { formatAmount } from '../format.js';
import { shortAddress } from '../../core/send/recipient.js';
import type { TokenEntry } from '../../core/token/TokenRegistry.js';
import { decryptHistoryAmounts, knownAmount } from '../../core/token/historyAmounts.js';
import { listTransactions, type Transaction } from '../../storage/TransactionStore.js';
import { wrapperSymbols } from '../../storage/WrapperCache.js';
import { describeError } from '../errors.js';
import { effect, type Effect } from '../effects.js';
import { isUnlocked, type AppState, type HistoryRow } from '../state.js';
import { dimLine, line, seg } from '../text.js';
import { sessionOf } from './data.js';

// Lives here, not in manage.ts: manage.ts imports this module, and a shared helper in
// manage.ts made the two import each other.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 19 14:02" in local time. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

/** How many transfers History shows. */
export const HISTORY_LIMIT = 200;

/** One display row for a stored transaction. */
export function toHistoryRow(
  t: Transaction,
  wallet: string,
  names: Map<string, string>,
  tokens: TokenEntry[],
  wrappers: Record<string, { underlying: { symbol: string } }> = {},
): HistoryRow {
  const out = t.from.toLowerCase() === wallet.toLowerCase();
  const other = out ? t.to : t.from;
  const kind: HistoryRow['kind'] =
    t.type === 'eth'
      ? out
        ? 'eth out'
        : 'eth in'
      : t.type === 'mint'
        ? 'mint'
        : t.type === 'burn'
          ? 'burn'
          : out
            ? 'sent'
            : 'received';
  const sign = out ? '-' : '+';
  let amount = t.amount === null ? 'encrypted' : `${sign}${t.amount}`;
  const known = t.amount === null ? knownAmount(t) : null;
  const token = tokens.find((x) => x.address.toLowerCase() === t.tokenAddress.toLowerCase());
  if (known && token) amount = `${sign}${formatAmount(known.value, token.decimals)}`;
  else if (t.amount !== null && token) {
    // A stored plain amount ("0.004") in the same style as decrypted ones ("+25.00").
    try {
      amount = `${sign}${formatAmount(parseUnits(t.amount, token.decimals), token.decimals)}`;
    } catch {
      // not a decimal number: shown as stored
    }
  }
  return {
    when: shortWhen(t.timestamp),
    kind,
    amount,
    token: t.tokenSymbol,
    counterparty: counterpartyLabel(t, other, names, wrappers),
    txHash: t.txHash,
    ...(t.amountHandle ? { handle: t.amountHandle, tokenAddress: t.tokenAddress } : {}),
    ...(known?.disclosed ? { disclosed: true } : {}),
    // Sent, but no receipt yet (recorded with block 0 after SENT_UNCONFIRMED).
    ...(t.blockNumber === 0 ? { unconfirmed: true } : {}),
  };
}

const ZERO_ADDRESS = /^0x0{40}$/i;

/**
 * Who the transfer was with. A mint or burn has the zero address on the other side, which
 * means nothing to a reader: for a wrapper token it is a wrap ("from ZAMA") or an unwrap
 * request ("to ZAMA"), otherwise there is no other party ("—").
 */
function counterpartyLabel(
  t: Transaction,
  other: string,
  names: Map<string, string>,
  wrappers: Record<string, { underlying: { symbol: string } }>,
): string {
  if (!ZERO_ADDRESS.test(other)) return names.get(other.toLowerCase()) ?? shortAddress(other);
  const w = wrappers[t.tokenAddress.toLowerCase()];
  if (!w) return '—';
  return t.type === 'burn' ? `to ${w.underlying.symbol}` : `from ${w.underlying.symbol}`;
}

/** Unconfirmed sends first (they are the newest), then by block as stored. */
export function unconfirmedFirst(rows: HistoryRow[]): HistoryRow[] {
  return [...rows.filter((r) => r.unconfirmed), ...rows.filter((r) => !r.unconfirmed)];
}

/** Rows for the current wallet and network, newest first. */
export function historyRows(s: AppState): HistoryRow[] {
  const wallet = s.wallet;
  if (!wallet) return [];
  const names = new Map(s.data.contacts.map((c) => [c.address.toLowerCase(), c.name]));
  // All rows, so unconfirmed sends (block 0, sorted last by the store) are never cut.
  const wrappers = wrapperSymbols(s.network); // once, not per row
  return unconfirmedFirst(
    listTransactions({ walletAddress: wallet.address, network: s.network, limit: 100_000 }).map(
      (t) => toHistoryRow(t, wallet.address, names, s.data.tokens, wrappers),
    ),
  ).slice(0, HISTORY_LIMIT);
}

/** True when some shown transfer has an amount that could still be decrypted. */
export function hasEncryptedRows(s: AppState): boolean {
  return (s.history?.rows ?? []).some((r) => r.amount === 'encrypted' && r.handle);
}

/**
 * Decrypt the encrypted amounts in history in the background. Needs the wallet unlocked
 * (returns no effects otherwise); uses the same session signature as the balances.
 */
export function decryptHistory(s: AppState): Effect[] {
  if (!isUnlocked(s) || !s.wallet || !s.history) return [];
  const wallet = s.wallet;
  const network = s.network;
  const signer = s.signer!;
  const tokens = s.data.tokens;
  s.history.decrypting = true;
  return [
    effect('history-decrypt', async (deps) => {
      const session = sessionOf(deps, signer, network);
      const txs = listTransactions({
        walletAddress: wallet.address,
        network,
        limit: HISTORY_LIMIT,
      });
      const result = session
        ? await decryptHistoryAmounts(deps.backend, session, txs, tokens)
        : { decrypted: 0, hidden: 0, failed: 0 };
      return (st) => {
        if (!st.history) return;
        st.history.decrypting = false;
        if (st.network !== network || st.wallet?.address !== wallet.address) return;
        st.history.rows = historyRows(st);
        if (st.stack[st.stack.length - 1].id !== 'history') return;
        if (result.failed) {
          const why = describeError(result.error ?? new Error('unknown'), {
            action: 'decrypt',
          }).title;
          st.flash = [
            line('  ', seg(`! Couldn't decrypt ${result.failed} amount(s): ${why}`, 'yellow')),
          ];
        } else if (result.decrypted) {
          st.flash = [dimLine(`  ✔ Decrypted ${result.decrypted} amount(s).`)];
        }
      };
    }),
  ];
}

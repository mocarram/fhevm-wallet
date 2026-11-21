/**
 * Operators: who may move this wallet's tokens (ERC-7984 `setOperator`). The screen
 * checks `isOperator` for addresses the wallet knows (contacts and recent counterparties);
 * an arbitrary address can be revoked by pasting it.
 */

import { parseOperatorExpiry, FOREVER_CONFIRMATION } from '../../core/send/operatorExpiry.js';
import { resolveRecipient } from '../../core/send/resolve.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import { describeError } from '../errors.js';
import { effect, type Effect } from '../effects.js';
import { open } from '../nav.js';
import { top, type AppState, type OperatorRow } from '../state.js';
import { addressLabel, startOperatorGrant, startOperatorRevoke } from './tx.js';

/** Most addresses checked at once (one isOperator call each). */
const MAX_CANDIDATES = 12;

/** Contacts first, then recent counterparties, without the wallet itself. */
export function operatorCandidates(s: AppState): string[] {
  const me = s.wallet?.address.toLowerCase();
  const out: string[] = [];
  const add = (a: string) => {
    const l = a.toLowerCase();
    if (l !== me && !/^0x0{40}$/.test(l) && !out.some((x) => x.toLowerCase() === l)) out.push(a);
  };
  for (const c of s.data.contacts) add(c.address);
  if (s.wallet) {
    try {
      for (const t of listTransactions({
        walletAddress: s.wallet.address,
        network: s.network,
        limit: 30,
      })) {
        add(t.from.toLowerCase() === me ? t.to : t.from);
      }
    } catch {
      // history is optional here
    }
  }
  for (const r of s.operators?.rows ?? []) if (r.isOperator) add(r.address);
  return out.slice(0, MAX_CANDIDATES);
}

/** Check which known addresses are operators for `token` (no unlock needed). */
export function loadOperators(s: AppState, token?: string): Effect[] {
  const address = s.wallet?.address;
  const t = token ?? s.operators?.token ?? s.data.tokens[0]?.address;
  if (!address || !t) return [];
  const network = s.network;
  const candidates = operatorCandidates(s);
  const rows = (status: Record<string, boolean>): OperatorRow[] =>
    candidates.map((a) => ({
      address: a,
      label: addressLabel(s, a),
      isOperator: Boolean(status[a.toLowerCase()]),
    }));
  s.operators = { token: t, rows: s.operators?.token === t ? s.operators.rows : [], loading: true };
  return [
    effect('operators', async (deps) => {
      try {
        const status = candidates.length
          ? await deps.backend.operatorStatus(t, address, candidates, network)
          : {};
        return (st) => {
          if (st.network !== network || st.wallet?.address !== address) return;
          st.operators = { token: t, rows: rows(status), loading: false };
        };
      } catch (err) {
        const msg = describeError(err, { action: 'operator check' }).title;
        return (st) => {
          st.operators = { token: t, rows: [], loading: false, error: `Couldn't check: ${msg}` };
        };
      }
    }),
  ];
}

/** Operator address step: a contact name or a pasted address. */
export function submitOperatorAddress(s: AppState): Effect[] {
  const text = (s.inputs.operatorAddr ?? '').trim();
  const r = resolveRecipient(text, s.data.contacts);
  if (!r.ok) {
    s.fieldError = [r.error, 'Paste the operator address, or type a contact name.'];
    return [];
  }
  if (r.address.toLowerCase() === s.wallet?.address.toLowerCase()) {
    s.fieldError = ['That is this wallet.', 'An operator is another address.'];
    return [];
  }
  const token = s.operators?.token;
  if (!token) return [];
  if (top(s).params.mode === 'revoke') return startOperatorRevoke(s, token, r.address);
  return open(s, 'operator-expiry', { address: r.address });
}

/** Expiry chosen from the menu or typed (1h, 1d, 7d, a date). "forever" asks to type it. */
export function chooseExpiry(s: AppState, text: string): Effect[] {
  const address = top(s).params.address;
  const token = s.operators?.token;
  if (!address || !token) return [];
  const r = parseOperatorExpiry(text, s.now);
  if (!r.ok) {
    s.fieldError = [r.error, r.hint];
    return [];
  }
  if (r.forever) {
    delete s.inputs.operatorForever;
    return open(s, 'operator-forever', { address });
  }
  return startOperatorGrant(s, token, address, r.until);
}

/** "No expiry" needs the word typed out: an operator can move everything, for good. */
export function confirmForever(s: AppState): Effect[] {
  const address = top(s).params.address;
  const token = s.operators?.token;
  if (!address || !token) return [];
  if ((s.inputs.operatorForever ?? '').trim().toLowerCase() !== FOREVER_CONFIRMATION) {
    s.fieldError = [
      `Type ${FOREVER_CONFIRMATION} to grant without expiry.`,
      'Or press Esc and pick a duration instead.',
    ];
    return [];
  }
  const r = parseOperatorExpiry(FOREVER_CONFIRMATION, s.now);
  return r.ok ? startOperatorGrant(s, token, address, r.until) : [];
}

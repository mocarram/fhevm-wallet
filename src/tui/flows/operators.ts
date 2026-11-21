/**
 * Operators: who may move this wallet's tokens (ERC-7984 `setOperator`). The screen
 * checks `isOperator` for addresses the wallet knows (contacts and recent counterparties);
 * an arbitrary address can be revoked by pasting it.
 */

import { parseOperatorExpiry, FOREVER_CONFIRMATION } from '../../core/send/operatorExpiry.js';
import { findLookAlike } from '../../core/send/recipient.js';
import { resolveRecipient } from '../../core/send/resolve.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import { knownOperatorUntil } from '../../storage/UiPrefsStore.js';
import { describeError } from '../errors.js';
import { effect, type Effect } from '../effects.js';
import { open, openInstead } from '../nav.js';
import { top, type AppState, type OperatorRow } from '../state.js';
import { addressLabel, startOperatorGrant, startOperatorRevoke } from './tx.js';

/** The remembered expiry of a grant (ui-prefs.json); undefined when unknown or unreadable. */
function knownUntil(network: AppState['network'], token: string, holder: string, op: string) {
  try {
    return knownOperatorUntil(network, token, holder, op);
  } catch {
    return undefined;
  }
}

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
    candidates.map((a) => {
      const isOperator = Boolean(status[a.toLowerCase()]);
      return {
        address: a,
        label: addressLabel(s, a),
        isOperator,
        until: isOperator ? knownUntil(network, t, address, a) : undefined,
      };
    });
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
  if (!text) {
    s.fieldError = ['Type or paste the operator address.', 'A contact name works too.'];
    return [];
  }
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
  // Revoking only ever takes power away, so a mistyped address there costs a fee, not
  // funds; but revoking an address that is not an operator would pay that fee for
  // nothing, so check first.
  if (top(s).params.mode === 'revoke') return checkThenRevoke(s, token, r.address);
  if (!r.contact) {
    // Address poisoning: an operator can take everything, so the same stop as Send.
    const lookalike = findLookAlike(r.address, s.data.contacts);
    if (lookalike)
      return open(s, 'operator-check', { address: r.address, contact: lookalike.name });
  }
  return open(s, 'operator-expiry', expiryParams(s, r.address));
}

/** Revoke `operator` only if it is an operator now; otherwise say so, nothing is sent. */
function checkThenRevoke(s: AppState, token: string, operator: string): Effect[] {
  const holder = s.wallet?.address;
  if (!holder) return [];
  const network = s.network;
  s.busy = 'Checking the operator';
  return [
    effect('operator-revoke-check', async (deps) => {
      let isOp: boolean | null = null;
      try {
        const status = await deps.backend.operatorStatus(token, holder, [operator], network);
        isOp = Boolean(status[operator.toLowerCase()]);
      } catch {
        // Could not check: the review simulates the revoke anyway.
      }
      return (st) => {
        st.busy = null;
        if (top(st).id !== 'operator-addr') return;
        if (isOp === false) {
          const symbol = st.data.tokens.find((t) => t.address === token)?.symbol ?? 'this token';
          st.fieldError = [
            `${addressLabel(st, operator)} is not an operator for ${symbol}.`,
            'There is nothing to revoke. Nothing was signed or sent.',
          ];
          return [];
        }
        return startOperatorRevoke(st, token, operator);
      };
    }),
  ];
}

/** Params for the expiry step: marks addresses that are neither contacts nor sent to. */
function expiryParams(s: AppState, address: string, lookalike = false): Record<string, string> {
  const a = address.toLowerCase();
  const known =
    s.data.contacts.some((c) => c.address.toLowerCase() === a) ||
    s.data.knownRecipients.includes(a);
  const params: Record<string, string> = { address };
  if (!known) params.isNew = '1';
  if (lookalike) params.lookalike = '1';
  return params;
}

/** Look-alike stop: grant the saved contact instead. */
export function useOperatorContactInstead(s: AppState, contactName: string): Effect[] {
  const c = s.data.contacts.find((x) => x.name === contactName);
  if (!c) return [];
  return openInstead(s, 'operator-expiry', { address: c.address });
}

/** Look-alike stop: the user checked every character and wants the pasted address. */
export function usePastedOperatorLookalike(s: AppState, address: string): Effect[] {
  return openInstead(s, 'operator-expiry', expiryParams(s, address, true));
}

/** Extra Review warnings for a grant to a first-time or look-alike address. */
export function operatorAddressNotes(params: Record<string, string>): string[] {
  const out: string[] = [];
  if (params.lookalike) {
    out.push('You confirmed a look-alike of a contact. Check every character once more.');
  }
  if (params.isNew) {
    out.push('First time using this address: it is not a contact and you never sent to it.');
  }
  return out;
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
    return open(s, 'operator-forever', { ...top(s).params });
  }
  return startOperatorGrant(s, token, address, r.until, operatorAddressNotes(top(s).params));
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
  return r.ok
    ? startOperatorGrant(s, token, address, r.until, operatorAddressNotes(top(s).params))
    : [];
}

/**
 * What the send wizard checks a pasted address against for look-alikes: contacts, the
 * user's own wallets and the counterparties in their history. The list itself is core's
 * `lookAlikeCandidates` (src/core/send/recipient.ts), shared with `fhew send`; this
 * module only reads its labels back for the TUI's stop screen.
 */

import { lookAlikeCandidates, type ContactLike } from '../../core/send/recipient.js';
import type { AppState } from '../state.js';

/** Kinds of a look-alike match, for the wording on the stop screen. */
export type MatchKind = 'contact' | 'wallet' | 'history';

/** Label prefix core's candidates use for own wallets (`your wallet "alice"`). */
const WALLET_PREFIX = 'your wallet "';
/** Label core's candidates use for history counterparties. */
export const HISTORY_LABEL = 'an address from your history';

export { lookAlikeCandidates };

/** The candidates for the TUI's current state. */
export function tuiLookAlikeCandidates(s: AppState): ContactLike[] {
  return lookAlikeCandidates({
    contacts: s.data.contacts,
    wallets: s.data.wallets,
    counterparties: s.data.counterparties ?? s.data.knownRecipients,
  });
}

/** Which kind of address a candidate label stands for. */
export function matchKind(label: string): MatchKind {
  if (label === HISTORY_LABEL) return 'history';
  if (label.startsWith(WALLET_PREFIX)) return 'wallet';
  return 'contact';
}

/** "your contact bob", "your wallet "alice"" or "an address from your history". */
export function matchPhrase(label: string): string {
  return matchKind(label) === 'contact' ? `your contact ${label}` : label;
}

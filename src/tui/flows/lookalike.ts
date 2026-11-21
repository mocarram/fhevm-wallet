/**
 * What the send wizard checks a pasted address against for look-alikes: contacts, the
 * user's own wallets and the counterparties in their history.
 *
 * INTEGRATION ADAPTER: wip/fix-core adds `lookAlikeCandidates` to
 * src/core/send/recipient.ts with this exact signature and the same labels. When that
 * lands, delete `lookAlikeCandidates` below and re-export the core one; nothing else
 * changes.
 */

import type { ContactLike } from '../../core/send/recipient.js';
import type { AppState } from '../state.js';

/** Kinds of a look-alike match, for the wording on the stop screen. */
export type MatchKind = 'contact' | 'wallet' | 'history';

/** Label prefix the candidates use for own wallets (`your wallet "alice"`). */
const WALLET_PREFIX = 'your wallet "';
/** Label the candidates use for history counterparties. */
export const HISTORY_LABEL = 'an address from your history';

/**
 * One list to check look-alikes against: contacts first, then the user's own wallets,
 * then addresses from history, each address once (same as core's on wip/fix-core).
 */
export function lookAlikeCandidates(sources: {
  contacts?: ContactLike[];
  wallets?: Array<{ name: string; address: string }>;
  counterparties?: string[];
}): ContactLike[] {
  const seen = new Set<string>();
  const out: ContactLike[] = [];
  const add = (name: string, address: string) => {
    const k = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(k) || seen.has(k)) return;
    seen.add(k);
    out.push({ name, address });
  };
  for (const c of sources.contacts ?? []) add(c.name, c.address);
  for (const w of sources.wallets ?? []) add(`${WALLET_PREFIX}${w.name}"`, w.address);
  for (const a of sources.counterparties ?? []) add(HISTORY_LABEL, a);
  return out;
}

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

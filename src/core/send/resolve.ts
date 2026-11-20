/**
 * Resolve what a user typed for "who" and "which token" in a one-line send
 * (`fhew send bob 25 cusdc`, or `:send bob 25 cusdc` in the TUI).
 */

import { parseAddressInput, type ContactLike } from './recipient.js';

/** A tracked token, as resolution needs it. */
export interface TokenLike {
  address: string;
  symbol: string;
}

/** Result of resolving a recipient. */
export type RecipientResolution<C extends ContactLike> =
  { ok: true; address: string; contact: C | null } | { ok: false; error: string };

/**
 * Resolve a contact name (case-insensitive) or an address. An address that belongs to a
 * contact is returned with that contact, so the UI can show the name.
 */
export function resolveRecipient<C extends ContactLike>(
  text: string,
  contacts: C[],
): RecipientResolution<C> {
  const wanted = text.trim();
  if (wanted.toLowerCase().startsWith('0x')) {
    const parsed = parseAddressInput(wanted);
    if (!parsed.ok) return parsed;
    const contact =
      contacts.find((c) => c.address.toLowerCase() === parsed.address.toLowerCase()) ?? null;
    return { ok: true, address: parsed.address, contact };
  }
  const contact = contacts.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!contact) {
    return {
      ok: false,
      error: `No contact called "${wanted}". Use a saved name, or paste an address.`,
    };
  }
  return { ok: true, address: contact.address, contact };
}

/** Result of resolving a token. */
export type TokenResolution<T extends TokenLike> =
  { ok: true; token: T } | { ok: false; error: string };

/**
 * Resolve a token by symbol (case-insensitive) or contract address among `tokens`.
 * A symbol shared by two tracked tokens is ambiguous and refused rather than guessed.
 */
export function resolveToken<T extends TokenLike>(text: string, tokens: T[]): TokenResolution<T> {
  const wanted = text.trim().toLowerCase();
  const byAddress = tokens.find((t) => t.address.toLowerCase() === wanted);
  if (byAddress) return { ok: true, token: byAddress };
  const bySymbol = tokens.filter((t) => t.symbol.toLowerCase() === wanted);
  if (bySymbol.length === 1) return { ok: true, token: bySymbol[0] };
  if (bySymbol.length > 1) {
    return {
      ok: false,
      error: `More than one tracked token is called "${text.trim()}". Use its address instead.`,
    };
  }
  const known = tokens.map((t) => t.symbol.toLowerCase()).join(', ');
  return {
    ok: false,
    error: `No tracked token called "${text.trim()}".${known ? ` Try ${known}.` : ''}`,
  };
}

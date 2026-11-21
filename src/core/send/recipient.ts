/**
 * Recipient checks shared by the send wizard, the command bar and `fhew send`.
 *
 * Address poisoning: scammers send tiny transfers from addresses whose first and last
 * characters match one of your contacts, hoping you copy the wrong one from history.
 * Wallet UIs usually show only `0x91bE…07aF`, so a look-alike is invisible there. We stop
 * the send when a pasted address shares the first 4 and last 4 hex characters with a saved
 * contact but is not that contact. Look-alikes are checked against everything the user
 * may copy an address from: contacts, their own wallets and the counterparties in their
 * history (`lookAlikeCandidates`).
 */

import { getAddress, isAddress } from 'ethers';

/** A saved contact, as the checks need it. */
export interface ContactLike {
  name: string;
  address: string;
}

/** Outcome of reading a pasted or typed address. */
export type AddressParse = { ok: true; address: string } | { ok: false; error: string };

/**
 * Validate a typed or pasted address and return it in checksum form.
 *
 * All-lowercase and all-uppercase addresses carry no checksum and are accepted. A
 * mixed-case address must match its EIP-55 checksum, which catches a mistyped character.
 */
export function parseAddressInput(input: string): AddressParse {
  const text = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    return { ok: false, error: 'An address is 0x followed by 40 hex characters.' };
  }
  if (!isAddress(text)) {
    return {
      ok: false,
      error: "The address checksum doesn't match. A character may be mistyped; copy it again.",
    };
  }
  return { ok: true, address: getAddress(text) };
}

/** The zero address: tokens refuse it as a receiver (and burning is not "sending"). */
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Why a send to `to` must not happen, or null. Sending a token to its own contract
 * address loses it for good (the contract cannot move it back), and the token refuses
 * the zero address anyway; both are typing or copying mistakes worth stopping early.
 */
export function recipientRefusal(to: string, tokenAddress: string): string | null {
  const t = to.toLowerCase();
  if (t === tokenAddress.toLowerCase()) {
    return 'That is the address of the token contract itself. Tokens sent there are lost for good; send to a wallet address instead.';
  }
  if (t === ZERO)
    return 'That is the zero address. Tokens sent there are lost; check the recipient.';
  return null;
}

/** A warning (not a refusal) for sending to the wallet's own address, or null. */
export function selfSendWarning(to: string, from: string): string | null {
  return to.toLowerCase() === from.toLowerCase()
    ? 'This is your own address: the tokens stay in this wallet and you only pay the network fee.'
    : null;
}

/**
 * One list to check look-alikes against: contacts first (their names are the most
 * useful in a warning), then the user's own wallets, then addresses from history, each
 * address once. Names for the last two say where the address came from.
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
  for (const w of sources.wallets ?? []) add(`your wallet "${w.name}"`, w.address);
  for (const a of sources.counterparties ?? []) add('an address from your history', a);
  return out;
}

/** Number of hex characters compared at each end of an address. */
export const LOOKALIKE_CHARS = 4;

/**
 * Find a contact that `address` imitates: same first and last 4 hex characters
 * (case-insensitive) but a different address. Returns null when there is none, or when
 * `address` is itself a saved contact.
 */
export function findLookAlike<T extends ContactLike>(address: string, contacts: T[]): T | null {
  const a = address.toLowerCase();
  if (contacts.some((c) => c.address.toLowerCase() === a)) return null;
  const head = a.slice(2, 2 + LOOKALIKE_CHARS);
  const tail = a.slice(-LOOKALIKE_CHARS);
  return (
    contacts.find((c) => {
      const b = c.address.toLowerCase();
      return b.slice(2, 2 + LOOKALIKE_CHARS) === head && b.slice(-LOOKALIKE_CHARS) === tail;
    }) ?? null
  );
}

/**
 * Split an address into [start, middle, end] around the compared characters, so a UI can
 * highlight the part that differs from a look-alike contact.
 */
export function splitForComparison(address: string): [string, string, string] {
  const head = 2 + LOOKALIKE_CHARS;
  return [
    address.slice(0, head),
    address.slice(head, -LOOKALIKE_CHARS),
    address.slice(-LOOKALIKE_CHARS),
  ];
}

/** Short form used in lists and the status bar: `0x91bE…07aF`. */
export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

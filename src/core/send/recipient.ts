/**
 * Recipient checks shared by the send wizard, the command bar and `fhew send`.
 *
 * Address poisoning: scammers send tiny transfers from addresses whose first and last
 * characters match one of your contacts, hoping you copy the wrong one from history.
 * Wallet UIs usually show only `0x91bE…07aF`, so a look-alike is invisible there. We stop
 * the send when a pasted address shares the first 4 and last 4 hex characters with a saved
 * contact but is not that contact.
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

/**
 * Address book storage for saving frequently used addresses
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { DATA_DIR, ensureDataDir } from './paths.js';

const AddressEntrySchema = z.object({
  name: z.string(),
  address: z.string(),
  addedAt: z.string(),
});

const AddressBookSchema = z.object({
  entries: z.array(AddressEntrySchema),
});

export type AddressEntry = z.infer<typeof AddressEntrySchema>;
type AddressBookData = z.infer<typeof AddressBookSchema>;

const ADDRESS_BOOK_FILE = join(DATA_DIR, 'addressbook.json');

/**
 * Load address book from file
 */
function loadAddressBook(): AddressBookData {
  ensureDataDir();

  if (!existsSync(ADDRESS_BOOK_FILE)) {
    return { entries: [] };
  }

  try {
    const data = readFileSync(ADDRESS_BOOK_FILE, 'utf-8');
    return AddressBookSchema.parse(JSON.parse(data));
  } catch {
    return { entries: [] };
  }
}

/**
 * Save address book to file
 */
function saveAddressBook(book: AddressBookData): void {
  ensureDataDir();
  writeFileSync(ADDRESS_BOOK_FILE, JSON.stringify(book, null, 2));
}

/**
 * Add a new address to the address book
 * Deduplicates by address (case-insensitive)
 */
export function addAddress(name: string, address: string): AddressEntry {
  const book = loadAddressBook();
  const normalizedAddress = address.toLowerCase();

  // Check if address already exists
  const existingByAddress = book.entries.find((e) => e.address.toLowerCase() === normalizedAddress);
  if (existingByAddress) {
    throw new Error(`Address already saved as "${existingByAddress.name}"`);
  }

  // Check if name already exists
  const existingByName = book.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (existingByName) {
    throw new Error(`Contact name "${name}" already exists`);
  }

  const entry: AddressEntry = {
    name,
    address,
    addedAt: new Date().toISOString(),
  };

  book.entries.push(entry);
  saveAddressBook(book);

  return entry;
}

/**
 * List all addresses in the address book
 */
export function listAddresses(): AddressEntry[] {
  const book = loadAddressBook();
  return [...book.entries].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get an address by contact name
 */
export function getAddressByName(name: string): AddressEntry | null {
  const book = loadAddressBook();
  return book.entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Get contact name by address (reverse lookup)
 */
export function getNameByAddress(address: string): string | null {
  const book = loadAddressBook();
  const entry = book.entries.find((e) => e.address.toLowerCase() === address.toLowerCase());
  return entry?.name ?? null;
}

/**
 * Remove an address from the address book by name
 */
export function removeAddress(name: string): boolean {
  const book = loadAddressBook();
  const index = book.entries.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());

  if (index === -1) {
    return false;
  }

  book.entries.splice(index, 1);
  saveAddressBook(book);
  return true;
}

/**
 * Check if an address exists in the address book
 */
export function hasAddress(address: string): boolean {
  const book = loadAddressBook();
  return book.entries.some((e) => e.address.toLowerCase() === address.toLowerCase());
}

/**
 * Check if a contact name exists
 */
export function hasContactName(name: string): boolean {
  const book = loadAddressBook();
  return book.entries.some((e) => e.name.toLowerCase() === name.toLowerCase());
}

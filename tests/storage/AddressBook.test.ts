import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAddress,
  getAddressByName,
  getNameByAddress,
  hasAddress,
  hasContactName,
  listAddresses,
  removeAddress,
} from '../../src/storage/AddressBook.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

const ALICE = '0x52908400098527886E0F7030069857D2E4169EE7';
const BOB = '0xde709f2102306220921060314715629080e2fb77';

beforeEach(() => {
  wipeTestDataDir();
});

describe('AddressBook', () => {
  it('adds and lists entries sorted by name', () => {
    addAddress('Bob', BOB);
    addAddress('Alice', ALICE);

    const list = listAddresses();
    expect(list.map((e) => e.name)).toEqual(['Alice', 'Bob']);
  });

  it('rejects duplicate addresses (case-insensitive)', () => {
    addAddress('Alice', ALICE);
    expect(() => addAddress('Other', ALICE.toLowerCase())).toThrow(/already saved/);
  });

  it('rejects duplicate names (case-insensitive)', () => {
    addAddress('Alice', ALICE);
    expect(() => addAddress('alice', BOB)).toThrow(/already exists/);
  });

  it('looks up by name and reverse-looks up by address', () => {
    addAddress('Alice', ALICE);
    expect(getAddressByName('alice')?.address).toBe(ALICE);
    expect(getNameByAddress(ALICE.toLowerCase())).toBe('Alice');
    expect(getNameByAddress(BOB)).toBeNull();
  });

  it('removes entries and reports presence', () => {
    addAddress('Alice', ALICE);
    expect(hasContactName('Alice')).toBe(true);
    expect(hasAddress(ALICE)).toBe(true);

    expect(removeAddress('alice')).toBe(true);
    expect(removeAddress('alice')).toBe(false);
    expect(hasContactName('Alice')).toBe(false);
  });
});

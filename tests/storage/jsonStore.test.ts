import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestDataDir, wipeTestDataDir } from '../helpers/dataDir.js';
import { setStoreWarningSink } from '../../src/storage/jsonStore.js';
import { addAddress, listAddresses } from '../../src/storage/AddressBook.js';
import { loadConfig } from '../../src/storage/ConfigStore.js';

const warnings: string[] = [];
beforeEach(() => {
  wipeTestDataDir();
  mkdirSync(getTestDataDir(), { recursive: true, mode: 0o700 });
  warnings.length = 0;
  setStoreWarningSink((m) => warnings.push(m));
});

describe('damaged store files (M6)', () => {
  it('moves a damaged address book aside instead of saving over it', () => {
    const file = join(getTestDataDir(), 'addressbook.json');
    writeFileSync(file, '{"entries": [ {"name": "bob", "addr', { mode: 0o600 });
    expect(listAddresses()).toEqual([]);
    const moved = readdirSync(getTestDataDir()).filter((f) =>
      f.startsWith('addressbook.json.corrupt-'),
    );
    expect(moved).toHaveLength(1);
    expect(statSync(join(getTestDataDir(), moved[0])).mode & 0o777).toBe(0o600);
    expect(warnings[0]).toMatch(
      /address book .* could not be read, so it was moved to addressbook\.json\.corrupt-\d{8}T\d{6}Z/,
    );
    // A new book can be written; the damaged one is still there.
    addAddress('alice', '0x52908400098527886E0F7030069857D2E4169EE7');
    expect(existsSync(join(getTestDataDir(), moved[0]))).toBe(true);
  });

  it('does the same for settings that no longer match the schema', () => {
    writeFileSync(join(getTestDataDir(), 'config.json'), '{"defaultNetwork": 42}', { mode: 0o600 });
    expect(loadConfig().defaultNetwork).toBeDefined();
    expect(warnings[0]).toMatch(/settings file/);
  });
});

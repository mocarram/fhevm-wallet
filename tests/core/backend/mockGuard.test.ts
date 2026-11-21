import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  assertCommandSupportsMock,
  assertNotMockDataDir,
  commandName,
  LAUNCH_ENV,
  MOCK_MARKER,
  prepareMockDataDir,
} from '../../../src/core/backend/mockGuard.js';
import { createBackend } from '../../../src/core/backend/select.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'fhew-guard-'));
}

describe('prepareMockDataDir', () => {
  it('needs FHEVM_WALLET_HOME', () => {
    const dataDir = join(scratch(), 'd');
    for (const env of [{}, { FHEVM_WALLET_HOME: ' ' }]) {
      expect(() => prepareMockDataDir(env, { dataDir })).toThrow(/needs FHEVM_WALLET_HOME/);
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it('never uses the default folder, however it is spelled', () => {
    const home = scratch();
    mkdirSync(join(home, '.fhevm-wallet'));
    symlinkSync(join(home, '.fhevm-wallet'), join(home, 'link'));
    for (const dir of [
      join(home, '.fhevm-wallet'),
      join(home, '.fhevm-wallet', '.'),
      join(home, 'link'),
    ]) {
      expect(() => prepareMockDataDir({ FHEVM_WALLET_HOME: dir }, { dataDir: dir, home })).toThrow(
        /real wallet folder/,
      );
    }
    expect(existsSync(join(home, '.fhevm-wallet', MOCK_MARKER))).toBe(false);
  });

  it('marks a new or empty folder, then accepts it', () => {
    const root = scratch();
    for (const dataDir of [
      join(root, 'new'),
      (mkdirSync(join(root, 'empty')), join(root, 'empty')),
    ]) {
      prepareMockDataDir({ FHEVM_WALLET_HOME: dataDir }, { dataDir, home: root });
      expect(existsSync(join(dataDir, MOCK_MARKER))).toBe(true);
      writeFileSync(join(dataDir, 'tokens.json'), '{}');
      expect(() =>
        prepareMockDataDir({ FHEVM_WALLET_HOME: dataDir }, { dataDir, home: root }),
      ).not.toThrow();
    }
  });

  it('refuses a real folder that holds data, e.g. a Docker /data volume', () => {
    const dataDir = scratch();
    mkdirSync(join(dataDir, 'wallets'));
    writeFileSync(join(dataDir, 'transactions.json'), '{}');
    expect(() => prepareMockDataDir({ FHEVM_WALLET_HOME: dataDir }, { dataDir })).toThrow(
      /already holds files and is not a mock folder/,
    );
    expect(existsSync(join(dataDir, MOCK_MARKER))).toBe(false);
  });
});

describe('the marker tags the folder as simulated', () => {
  it('the real backend refuses a mock folder', () => {
    const dataDir = scratch();
    prepareMockDataDir({ FHEVM_WALLET_HOME: dataDir }, { dataDir });
    expect(() => assertNotMockDataDir(dataDir)).toThrow(/holds simulated data/);
    expect(() => createBackend({}, { dataDir })).toThrow(/holds simulated data/);
    expect(
      createBackend({ FHEW_BACKEND: 'mock', FHEVM_WALLET_HOME: dataDir }, { dataDir }).kind,
    ).toBe('mock');
    expect(() => assertNotMockDataDir(scratch())).not.toThrow();
  });
});

describe('launch environment', () => {
  it('is a frozen copy taken at load time', () => {
    expect(Object.isFrozen(LAUNCH_ENV)).toBe(true);
    const before = LAUNCH_ENV.FHEW_BACKEND;
    process.env.FHEW_BACKEND = 'mock';
    expect(LAUNCH_ENV.FHEW_BACKEND).toBe(before);
    delete process.env.FHEW_BACKEND;
  });
});

describe('commands under FHEW_BACKEND=mock', () => {
  it('allows the TUI, send, wallet and help; refuses network commands', () => {
    const argv = (...a: string[]) => ['node', 'fhew', ...a];
    expect(commandName(argv('-n', 'mainnet', 'send', 'bob'))).toBe('send');
    expect(commandName(argv('--network=sepolia'))).toBe('');
    for (const ok of [
      [],
      ['interactive'],
      ['i'],
      ['send', 'bob', '1'],
      ['wallet', 'list'],
      ['--help'],
    ]) {
      expect(() => assertCommandSupportsMock(argv(...ok))).not.toThrow();
    }
    for (const bad of [
      ['balance'],
      ['history'],
      ['token', 'add'],
      ['config', '--rpc-sepolia', '-'],
    ]) {
      expect(() => assertCommandSupportsMock(argv(...bad))).toThrow(/would use the real network/);
    }
  });
});

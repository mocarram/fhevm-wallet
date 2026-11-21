import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_FILE_PATH,
  getEnvVar,
  listEnvVars,
  loadEnv,
  removeEnvVar,
  saveEnvVar,
  settingSource,
  assertTrustedDataDir,
  ensureDataDir,
  isPrivateGroup,
  untrustedAncestor,
} from '../../src/storage/paths.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';

beforeEach(() => {
  wipeTestDataDir();
  delete process.env.TEST_KEY;
});

describe('env file CRUD', () => {
  it('saveEnvVar creates the file and updates process.env', () => {
    saveEnvVar('TEST_KEY', 'value-1');
    expect(getEnvVar('TEST_KEY')).toBe('value-1');
    expect(process.env.TEST_KEY).toBe('value-1');
  });

  it('saveEnvVar overwrites an existing key', () => {
    saveEnvVar('TEST_KEY', 'first');
    saveEnvVar('TEST_KEY', 'second');
    expect(getEnvVar('TEST_KEY')).toBe('second');
  });

  it('removeEnvVar removes the line and reports presence', () => {
    saveEnvVar('TEST_KEY', 'value');
    expect(removeEnvVar('TEST_KEY')).toBe(true);
    expect(getEnvVar('TEST_KEY')).toBeUndefined();
    expect(process.env.TEST_KEY).toBeUndefined();
    expect(removeEnvVar('TEST_KEY')).toBe(false);
  });

  it('listEnvVars returns all key/value pairs', () => {
    saveEnvVar('A', '1');
    saveEnvVar('B', '2');
    expect(listEnvVars()).toEqual({ A: '1', B: '2' });
  });

  it('loadEnv applies saved settings over the environment', () => {
    saveEnvVar('ETHERSCAN_API_KEY', 'from-file');
    process.env.ETHERSCAN_API_KEY = 'from-shell';
    try {
      loadEnv();
      expect(process.env.ETHERSCAN_API_KEY).toBe('from-file');
    } finally {
      delete process.env.ETHERSCAN_API_KEY;
    }
  });

  it('the data-dir .env only supplies settings the wallet saves (regression)', () => {
    ensureDataDir();
    writeFileSync(
      ENV_FILE_PATH,
      'SEPOLIA_RPC_URL=https://saved.example\nFHEW_BACKEND=mock\nFHEW_DEBUG=1\nFHEVM_WALLET_HOME=/tmp/x\nNODE_OPTIONS=--inspect\n',
      { mode: 0o600 },
    );
    delete process.env.FHEW_BACKEND;
    delete process.env.FHEW_DEBUG;
    try {
      const res = loadEnv(join(tmpdir(), 'no-such-dir', '.env'));
      expect(process.env.SEPOLIA_RPC_URL).toBe('https://saved.example');
      expect(process.env.FHEW_BACKEND).toBeUndefined();
      expect(process.env.FHEW_DEBUG).toBeUndefined();
      expect(process.env.FHEVM_WALLET_HOME).toBeUndefined();
      expect(res.ignoredFromSettings).toEqual([
        'FHEW_BACKEND',
        'FHEW_DEBUG',
        'FHEVM_WALLET_HOME',
        'NODE_OPTIONS',
      ]);
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a data dir, wallets/ or .env that others can write to, or a symlinked entry',
    () => {
      const rm = rmSync;
      const dataDir = join(ENV_FILE_PATH, '..');
      mkdirSync(join(dataDir, 'wallets'), { recursive: true, mode: 0o700 });
      writeFileSync(ENV_FILE_PATH, 'ETHERSCAN_API_KEY=x\n', { mode: 0o600 });
      expect(() => assertTrustedDataDir()).not.toThrow();
      chmodSync(ENV_FILE_PATH, 0o666);
      expect(() => assertTrustedDataDir()).toThrow(/Other users can change .*\.env/);
      chmodSync(ENV_FILE_PATH, 0o600);
      chmodSync(join(dataDir, 'wallets'), 0o777);
      expect(() => assertTrustedDataDir()).toThrow(/chmod -R go-w/);
      chmodSync(join(dataDir, 'wallets'), 0o700);
      rm(ENV_FILE_PATH);
      symlinkSync('/etc/hostname', ENV_FILE_PATH);
      expect(() => assertTrustedDataDir()).toThrow(/symbolic link/);
      rm(ENV_FILE_PATH);
    },
  );

  it('reads only allow-listed keys from ./.env, never debug or backend switches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    const file = join(dir, '.env');
    writeFileSync(
      file,
      'SEPOLIA_RPC_URL=https://rpc.example\nFHEW_DEBUG=1\nFHEW_BACKEND=mock\nNODE_OPTIONS=--inspect\n',
    );
    delete process.env.SEPOLIA_RPC_URL;
    try {
      const res = loadEnv(file);
      expect(process.env.SEPOLIA_RPC_URL).toBe('https://rpc.example');
      expect(process.env.FHEW_DEBUG).toBeUndefined();
      expect(process.env.FHEW_BACKEND).toBeUndefined();
      expect(res.fromCwd).toEqual(['SEPOLIA_RPC_URL']);
      expect(res.ignoredFromCwd).toEqual(['FHEW_DEBUG', 'FHEW_BACKEND', 'NODE_OPTIONS']);
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('./.env never overrides a value already in the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    writeFileSync(join(dir, '.env'), 'ETHERSCAN_API_KEY=from-cwd\n');
    process.env.ETHERSCAN_API_KEY = 'from-shell';
    try {
      expect(loadEnv(join(dir, '.env')).fromCwd).toEqual([]);
      expect(process.env.ETHERSCAN_API_KEY).toBe('from-shell');
    } finally {
      delete process.env.ETHERSCAN_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a plain-http remote RPC URL in ./.env and says why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    writeFileSync(join(dir, '.env'), 'SEPOLIA_RPC_URL=http://rpc.evil.example/key\n');
    delete process.env.SEPOLIA_RPC_URL;
    try {
      const res = loadEnv(join(dir, '.env'));
      expect(process.env.SEPOLIA_RPC_URL).toBeUndefined();
      expect(res.fromCwd).toEqual([]);
      expect(res.rejectedFromCwd).toEqual([
        { key: 'SEPOLIA_RPC_URL', reason: expect.stringMatching(/https/) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('settingSource tells saved settings, ./.env and the environment apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-env-'));
    writeFileSync(join(dir, '.env'), 'SEPOLIA_RPC_URL=https://cwd.example\n');
    delete process.env.SEPOLIA_RPC_URL;
    process.env.ETHERSCAN_API_KEY = 'from-shell';
    try {
      loadEnv(join(dir, '.env'));
      expect(settingSource('SEPOLIA_RPC_URL')).toBe('cwd');
      expect(settingSource('ETHERSCAN_API_KEY')).toBe('environment');
      expect(settingSource('ZAMA_MAINNET_API_KEY')).toBeNull();
      saveEnvVar('SEPOLIA_RPC_URL', 'https://saved.example');
      expect(settingSource('SEPOLIA_RPC_URL')).toBe('settings');
      // Saved settings win, so ./.env is no longer reported as in use for that key.
      expect(loadEnv(join(dir, '.env')).fromCwd).toEqual([]);
    } finally {
      delete process.env.SEPOLIA_RPC_URL;
      delete process.env.ETHERSCAN_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ENV_FILE_PATH lives under the test home', () => {
    expect(ENV_FILE_PATH).toMatch(/\.fhevm-wallet[/\\]\.env$/);
  });
});

describe('data dir trust: ancestors and private groups', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a data dir under a world-writable, non-sticky folder',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'fhew-anc-'));
      try {
        const open = join(base, 'open');
        mkdirSync(join(open, 'inner'), { recursive: true });
        chmodSync(open, 0o777);
        expect(untrustedAncestor(join(open, 'inner', 'data'))).toBe(open);
        chmodSync(open, 0o1777); // sticky, like /tmp: fine
        expect(untrustedAncestor(join(open, 'inner', 'data'))).toBeNull();
        chmodSync(open, 0o755);
        expect(untrustedAncestor(join(open, 'inner'))).toBeNull();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('isPrivateGroup: own-named group with no other members or primary users', () => {
    const group = 'root:x:0:\nalice:x:1000:\nstaff:x:50:alice,bob\nshared:x:1001:bob\n';
    const passwd = 'alice:x:1000:1000::/home/alice:/bin/sh\nbob:x:1001:1001::/home/bob:/bin/sh\n';
    const files = { group, passwd, username: 'alice' };
    expect(isPrivateGroup(1000, 1000, files)).toBe(true);
    expect(isPrivateGroup(50, 1000, files)).toBe(false); // named differently, shared
    expect(isPrivateGroup(1001, 1000, files)).toBe(false);
    expect(isPrivateGroup(4242, 1000, files)).toBe(false); // unknown group
    // Another account with it as primary group: not private.
    const passwd2 = passwd + 'carol:x:1002:1000::/home/carol:/bin/sh\n';
    expect(isPrivateGroup(1000, 1000, { ...files, passwd: passwd2 })).toBe(false);
    // A listed member other than the user: not private.
    const group2 = group.replace('alice:x:1000:', 'alice:x:1000:dave');
    expect(isPrivateGroup(1000, 1000, { ...files, group: group2 })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a group-writable file in the private group, refuses otherwise',
    () => {
      wipeTestDataDir();
      const dataDir = join(ENV_FILE_PATH, '..');
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(ENV_FILE_PATH, 'ETHERSCAN_API_KEY=x\n', { mode: 0o600 });
      chmodSync(ENV_FILE_PATH, 0o620);
      const gid = statSync(ENV_FILE_PATH).gid;
      const user = userInfo().username;
      const uid = process.getuid!();
      const priv = {
        group: `${user}:x:${gid}:\n`,
        passwd: `${user}:x:${uid}:${gid}::/h:/bin/sh\n`,
        username: user,
      };
      expect(assertTrustedDataDir(priv)).toEqual([ENV_FILE_PATH]);
      expect(statSync(ENV_FILE_PATH).mode & 0o777).toBe(0o600);
      // A shared group: still refused, nothing changed.
      chmodSync(ENV_FILE_PATH, 0o620);
      const shared = { ...priv, group: `${user}:x:${gid}:someone\n` };
      expect(() => assertTrustedDataDir(shared)).toThrow(/Other users can change/);
      expect(statSync(ENV_FILE_PATH).mode & 0o777).toBe(0o620);
      // World-writable: always refused.
      chmodSync(ENV_FILE_PATH, 0o622);
      expect(() => assertTrustedDataDir(priv)).toThrow(/Other users can change/);
      chmodSync(ENV_FILE_PATH, 0o600);
    },
  );
});

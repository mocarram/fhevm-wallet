import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendSecureFile,
  ensureSecureDir,
  tightenPermissions,
  writeNewPrivateFile,
  writeSecureFile,
} from '../../src/storage/secureFs.js';

const mode = (p: string) => statSync(p).mode & 0o777;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'securefs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('secureFs', () => {
  it('creates directories 0700 and tightens existing ones', () => {
    const dir = join(root, 'a', 'b');
    ensureSecureDir(dir);
    expect(mode(dir)).toBe(0o700);
    chmodSync(dir, 0o755);
    ensureSecureDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it('writes files 0600 atomically and leaves no temp files', () => {
    const file = join(root, 'data', 'config.json');
    writeSecureFile(file, '{"a":1}');
    writeSecureFile(file, '{"a":2}');
    expect(readFileSync(file, 'utf-8')).toBe('{"a":2}');
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(root, 'data'))).toEqual(['config.json']);
  });

  it('re-secures a pre-existing world-readable file on write', () => {
    const file = join(root, 'old.json');
    writeFileSync(file, 'x', { mode: 0o644 });
    writeSecureFile(file, 'y');
    expect(mode(file)).toBe(0o600);
  });

  it('appends with 0600', () => {
    const file = join(root, 'audit.log');
    appendSecureFile(file, 'one\n');
    appendSecureFile(file, 'two\n');
    expect(readFileSync(file, 'utf-8')).toBe('one\ntwo\n');
    expect(mode(file)).toBe(0o600);
  });

  it('tightens loose permissions recursively and reports what changed', () => {
    const dir = join(root, 'wallets');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(root, 0o755);
    writeFileSync(join(dir, 'w.json'), '{}', { mode: 0o644 });
    const changed = tightenPermissions(root);
    expect(changed).toHaveLength(3);
    expect(mode(join(dir, 'w.json'))).toBe(0o600);
    expect(tightenPermissions(root)).toEqual([]);
  });

  it('does not follow symlinks out of the data dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const target = join(outside, 'f');
    writeFileSync(target, 'x', { mode: 0o644 });
    chmodSync(root, 0o700);
    symlinkSync(target, join(root, 'link'));
    tightenPermissions(root);
    expect(mode(target)).toBe(0o644);
    rmSync(outside, { recursive: true, force: true });
  });

  it('leaves already-private files alone (does not loosen 0400 to 0600)', () => {
    chmodSync(root, 0o700);
    const file = join(root, 'readonly.json');
    writeFileSync(file, '{}', { mode: 0o400 });
    expect(tightenPermissions(root)).toEqual([]);
    expect(mode(file)).toBe(0o400);
  });

  it('follows the data dir itself when it is a symlink', () => {
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o755 });
    const link = join(root, 'link-to-data');
    symlinkSync(real, link);
    tightenPermissions(link);
    expect(mode(real)).toBe(0o700);
  });

  it('refuses to append through a symlink', () => {
    const target = join(root, 'elsewhere.txt');
    writeFileSync(target, '');
    symlinkSync(target, join(root, 'audit.log'));
    expect(() => appendSecureFile(join(root, 'audit.log'), 'x\n')).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf-8')).toBe('');
  });

  it('writeNewPrivateFile creates 0600, keeps the folder mode and never overwrites', () => {
    chmodSync(root, 0o755);
    const file = join(root, 'export.json');
    writeNewPrivateFile(file, 'secret');
    expect(mode(file)).toBe(0o600);
    expect(mode(root)).toBe(0o755);
    expect(() => writeNewPrivateFile(file, 'other')).toThrow(/EEXIST/);
    expect(readFileSync(file, 'utf-8')).toBe('secret');
  });
});

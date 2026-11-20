import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  appendSecureFile,
  ensureSecureDir,
  isSharedLocation,
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

  const ENTRIES = ['wallets', 'config.json', 'readonly.json', 'link'];

  it('tightens the data dir and the listed wallet paths, and reports what changed', () => {
    const dir = join(root, 'wallets');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(root, 0o755);
    writeFileSync(join(dir, 'w.json'), '{}', { mode: 0o644 });
    writeFileSync(join(root, 'config.json'), '{}', { mode: 0o664 });
    const changed = tightenPermissions(root, ENTRIES);
    expect(changed).toHaveLength(4);
    expect(mode(root)).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'w.json'))).toBe(0o600);
    expect(mode(join(root, 'config.json'))).toBe(0o600);
    expect(tightenPermissions(root, ENTRIES)).toEqual([]);
  });

  it('keeps owner bits: an executable stays executable (regression)', () => {
    chmodSync(root, 0o700);
    const script = join(root, 'config.json');
    writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    tightenPermissions(root, ENTRIES);
    expect(mode(script)).toBe(0o700);
  });

  it('never touches files the wallet did not create', () => {
    chmodSync(root, 0o700);
    const mine = join(root, 'deploy.sh');
    writeFileSync(mine, '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(root, 'project'), { mode: 0o755 });
    writeFileSync(join(root, 'project', 'notes.txt'), 'x', { mode: 0o644 });
    expect(tightenPermissions(root, ENTRIES)).toEqual([]);
    expect(mode(mine)).toBe(0o755);
    expect(mode(join(root, 'project'))).toBe(0o755);
    expect(mode(join(root, 'project', 'notes.txt'))).toBe(0o644);
  });

  it('refuses to tighten (or chmod) the home folder, the cwd or /', () => {
    const cwd = process.cwd();
    const before = mode(cwd);
    expect(isSharedLocation(cwd)).toBe(true);
    expect(isSharedLocation('/')).toBe(true);
    expect(isSharedLocation(homedir())).toBe(true);
    expect(isSharedLocation(root)).toBe(false);
    expect(tightenPermissions(cwd, ENTRIES)).toEqual([]);
    ensureSecureDir(cwd);
    expect(mode(cwd)).toBe(before);
  });

  it('does not follow symlinks out of the data dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const target = join(outside, 'f');
    writeFileSync(target, 'x', { mode: 0o644 });
    chmodSync(root, 0o700);
    symlinkSync(target, join(root, 'link'));
    tightenPermissions(root, ENTRIES);
    expect(mode(target)).toBe(0o644);
    rmSync(outside, { recursive: true, force: true });
  });

  it('leaves already-private files alone (does not loosen 0400 to 0600)', () => {
    chmodSync(root, 0o700);
    const file = join(root, 'readonly.json');
    writeFileSync(file, '{}', { mode: 0o400 });
    expect(tightenPermissions(root, ENTRIES)).toEqual([]);
    expect(mode(file)).toBe(0o400);
  });

  it('follows the data dir itself when it is a symlink', () => {
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o755 });
    const link = join(root, 'link-to-data');
    symlinkSync(real, link);
    tightenPermissions(link, ENTRIES);
    expect(mode(real)).toBe(0o700);
  });

  it('refuses to append through a dangling symlink (does not create its target)', () => {
    const target = join(root, 'not-there-yet.txt');
    symlinkSync(target, join(root, 'audit.log'));
    expect(() => appendSecureFile(join(root, 'audit.log'), 'x\n')).toThrow(/symbolic link/);
    expect(existsSync(target)).toBe(false);
  });

  it('re-secures an existing loose audit log on append', () => {
    const file = join(root, 'audit.log');
    writeFileSync(file, 'old\n', { mode: 0o644 });
    appendSecureFile(file, 'new\n');
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).toBe('old\nnew\n');
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

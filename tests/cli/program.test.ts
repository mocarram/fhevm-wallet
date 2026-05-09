import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/index.js';
import { wipeTestDataDir } from '../helpers/dataDir.js';

beforeEach(() => {
  wipeTestDataDir();
});

describe('createProgram', () => {
  it('exposes the expected top-level commands', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'balance',
        'config',
        'history',
        'interactive',
        'send',
        'token',
        'wallet',
      ]),
    );
  });

  it('renders --help without throwing', () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    expect(() => program.parse(['node', 'fhevm-wallet', '--help'])).toThrow(
      expect.objectContaining({ code: 'commander.helpDisplayed' }),
    );
  });

  it('config --show prints current configuration', async () => {
    const program = createProgram();
    program.exitOverride();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['node', 'fhevm-wallet', 'config', '--show']);

    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Current configuration');
    expect(output).toContain('Default network');

    log.mockRestore();
  });
});

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { adoptTypedNetwork, typedNetwork } from '../../../src/cli/utils/networkOption.js';

/** A program shaped like ours: a global -n and subcommands with their own. */
function program(seen: Record<string, unknown>) {
  const p = new Command().exitOverride().option('-n, --network <network>');
  p.hook('preAction', (_t, action) => adoptTypedNetwork(action));
  const token = p.command('token');
  token
    .command('list')
    .option('-n, --network <network>')
    .action((o) => (seen.list = o.network));
  p.command('wallet').action((_o, cmd: Command) => (seen.wallet = typedNetwork(cmd)));
  return p;
}

describe('adoptTypedNetwork', () => {
  it('gives the typed network to the subcommand, before or after its name', async () => {
    for (const argv of [
      ['token', 'list', '-n', 'mainnet'],
      ['-n', 'mainnet', 'token', 'list'],
      ['token', 'list', '--network', 'mainnet'],
    ]) {
      const seen: Record<string, unknown> = {};
      await program(seen).parseAsync(['node', 'fhew', ...argv]);
      expect(seen.list, argv.join(' ')).toBe('mainnet');
    }
  });

  it('leaves the option unset when nothing was typed, and ignores commands without one', async () => {
    const seen: Record<string, unknown> = {};
    await program(seen).parseAsync(['node', 'fhew', 'token', 'list']);
    expect(seen.list).toBeUndefined();
    await program(seen).parseAsync(['node', 'fhew', '-n', 'sepolia', 'wallet']);
    expect(seen.wallet).toBe('sepolia');
  });
});

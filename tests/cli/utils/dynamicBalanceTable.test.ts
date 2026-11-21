import { describe, expect, it, vi } from 'vitest';
import { DynamicBalanceTable } from '../../../src/cli/utils/DynamicBalanceTable.js';

describe('DynamicBalanceTable into a file or a pipe', () => {
  it('prints the final table once, without cursor redraws or colours', () => {
    const tty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
      lines.push(a.join(' '));
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const t = new DynamicBalanceTable({
        tokens: [
          {
            address: '0x52908400098527886E0F7030069857D2E4169EE7',
            name: 'Conf USD',
            symbol: 'cUSD',
            decimals: 6,
            network: 'sepolia',
            addedAt: '',
          },
        ],
        header: 'Balances',
        ethBalance: '0.5',
      });
      t.start();
      t.setLoading(0);
      t.setSuccess(0, '25');
      t.stop();
      expect(write).not.toHaveBeenCalled(); // log-update never ran
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/Balances[\s\S]*cUSD[\s\S]*25/);
      // eslint-disable-next-line no-control-regex
      expect(lines[0]).not.toMatch(/\x1b/);
    } finally {
      log.mockRestore();
      write.mockRestore();
      Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    }
  });
});

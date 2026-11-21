/**
 * Dynamic balance table with animated spinners
 */

import logUpdate from 'log-update';
import Table from 'cli-table3';
import chalk from 'chalk';
import { formatAddress, tableStyle } from '../../utils/formatting.js';
import { TokenEntry } from '../../core/token/TokenRegistry.js';

// Spinner frames for animation
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface TokenStatus {
  token: TokenEntry;
  status: 'pending' | 'loading' | 'success' | 'error';
  balance?: string;
  error?: string;
}

interface DynamicBalanceTableOptions {
  tokens: TokenEntry[];
  header: string;
  ethBalance?: string;
}

export class DynamicBalanceTable {
  private tokens: TokenStatus[];
  private frameIndex: number = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private header: string;
  private ethBalance?: string;
  /** Redraw in place only on a terminal. */
  private readonly live = Boolean(process.stdout.isTTY);

  constructor(options: DynamicBalanceTableOptions) {
    this.tokens = options.tokens.map((t) => ({ token: t, status: 'pending' }));
    this.header = options.header;
    this.ethBalance = options.ethBalance;
  }

  /**
   * Animate on a terminal. Into a file or a pipe nothing is drawn until `stop()`, which
   * prints the final table once: log-update's cursor moves would land in the file.
   */
  start(): void {
    if (!this.live) return;
    // Start spinner animation interval (80ms per frame)
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
    this.render();
  }

  setLoading(index: number): void {
    this.tokens[index].status = 'loading';
  }

  setSuccess(index: number, balance: string): void {
    this.tokens[index].status = 'success';
    this.tokens[index].balance = balance;
  }

  setError(index: number, error: string): void {
    this.tokens[index].status = 'error';
    this.tokens[index].error = error;
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (!this.live) {
      console.log(this.header + '\n' + this.table());
      return;
    }
    this.render(); // Final render
    logUpdate.done(); // Persist output
  }

  private getStatusIcon(status: TokenStatus): string {
    switch (status.status) {
      case 'pending':
        return chalk.dim('-');
      case 'loading':
        return chalk.cyan(SPINNER_FRAMES[this.frameIndex]);
      case 'success':
        return chalk.green('✔');
      case 'error':
        return chalk.red('✗');
    }
  }

  private render(): void {
    logUpdate(this.header + '\n' + this.table());
  }

  private table(): string {
    const table = new Table({
      head: ['', 'Token', 'Balance', 'Address'],
      style: tableStyle(),
      chars: {
        mid: '─',
        'left-mid': '├',
        'mid-mid': '┼',
        'right-mid': '┤',
      },
    });

    // Add ETH row first if provided
    if (this.ethBalance !== undefined) {
      table.push([chalk.dim('◆'), 'ETH', this.ethBalance, chalk.dim('Native')]);
    }

    for (const ts of this.tokens) {
      const icon = this.getStatusIcon(ts);
      const balance =
        ts.status === 'success'
          ? ts.balance
          : ts.status === 'error'
            ? chalk.red(ts.error || 'Error')
            : chalk.dim('-');

      table.push([icon, ts.token.symbol, balance, formatAddress(ts.token.address)]);
    }

    return table.toString();
  }
}

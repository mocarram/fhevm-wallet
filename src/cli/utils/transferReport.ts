/**
 * Shared wording for the outcome of a confirmed transfer, used by `fhew send` and the
 * interactive send so both report the balance re-check the same way.
 */

import chalk from 'chalk';
import type { TransferResult } from '../../core/token/TokenService.js';
import { formatTokenAmount } from '../../utils/formatting.js';

/**
 * Lines describing whether the tokens actually moved. ERC-7984 transfers that exceed the
 * balance move 0 without reverting, so a confirmed receipt alone is not proof.
 */
export function describeBalanceCheck(
  result: Pick<TransferResult, 'balanceCheck' | 'balanceAfter'>,
  symbol: string,
  decimals: number,
): string[] {
  const after =
    result.balanceAfter !== undefined
      ? ` New balance: ${formatTokenAmount(result.balanceAfter, decimals)} ${symbol}.`
      : '';
  switch (result.balanceCheck) {
    case 'moved':
      return [chalk.green(`✔ Your balance went down by the amount sent.${after}`)];
    case 'unchanged':
      return [
        chalk.yellow('! The transaction confirmed, but your balance did not change.'),
        chalk.yellow('  The token may have moved 0. Check the balance and the explorer.'),
      ];
    case 'changed':
      return [
        chalk.yellow(`! Your balance changed by a different amount than sent.${after}`),
        chalk.dim('  Another transfer may have arrived at the same time.'),
      ];
    default:
      return [chalk.dim("Couldn't re-check the balance just now. Run a balance check later.")];
  }
}

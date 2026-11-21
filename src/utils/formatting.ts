/**
 * Formatting utilities
 */

import chalk from 'chalk';

/**
 * NO_COLOR (https://no-color.org): any non-empty value turns colour off. chalk's colour
 * detection does not read it, so the CLI applies it once at startup (`applyNoColor`)
 * and tables pass `tableStyle` to cli-table3, which colours borders and headings itself.
 */
export function noColorRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== '';
}

/** Turn chalk off when NO_COLOR is set. */
export function applyNoColor(env: NodeJS.ProcessEnv = process.env): void {
  if (noColorRequested(env)) chalk.level = 0;
}

/**
 * cli-table3 `style`: cyan headings and grey borders on a colour terminal; none with
 * NO_COLOR or when stdout is a file or a pipe (cli-table3 colours by itself and would
 * write escape codes into the file).
 */
export function tableStyle(
  env: NodeJS.ProcessEnv = process.env,
  out: { isTTY?: boolean } = process.stdout,
): {
  head: string[];
  border: string[];
} {
  const plain = noColorRequested(env) || !out.isTTY || chalk.level === 0;
  return plain ? { head: [], border: [] } : { head: ['cyan'], border: ['grey'] };
}

/**
 * Format network name for display (adds beta tag for mainnet)
 */
export function formatNetworkName(network: string): string {
  return network === 'mainnet' ? 'mainnet (beta)' : network;
}

/**
 * Format an address for display (shortened)
 */
export function formatAddress(address: string, length = 8): string {
  if (address.length <= length * 2 + 2) {
    return address;
  }
  return `${address.slice(0, length + 2)}...${address.slice(-length)}`;
}

/**
 * Format a token amount with decimals
 */
export function formatTokenAmount(amount: bigint, decimals: number, precision = 4): string {
  const divisor = 10n ** BigInt(decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return integerPart.toString();
  }

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmedFractional = fractionalStr.slice(0, precision).replace(/0+$/, '');

  if (trimmedFractional === '') {
    return integerPart.toString();
  }

  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Format a date for display
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Success message
 */
export function success(message: string): string {
  return chalk.green(`✔ ${message}`);
}

/**
 * Error message
 */
export function error(message: string): string {
  return chalk.red(`✗ ${message}`);
}

/**
 * Warning message
 */
export function warning(message: string): string {
  return chalk.yellow(`! ${message}`);
}

/**
 * Info message
 */
export function info(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

/**
 * Dim text
 */
export function dim(text: string): string {
  return chalk.dim(text);
}

/**
 * Bold text
 */
export function bold(text: string): string {
  return chalk.bold(text);
}

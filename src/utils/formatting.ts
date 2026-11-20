/**
 * Formatting utilities
 */

import chalk from 'chalk';

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
 * Parse a human amount such as "1.25" into base units for a token with `decimals`.
 *
 * Strict on purpose: extra decimal places are rejected rather than silently truncated,
 * so the amount the user typed is exactly the amount that gets encrypted and sent.
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('Invalid amount format');
  }

  const [integerPart, fractionalPart = ''] = trimmed.split('.');
  if (fractionalPart.length > decimals) {
    throw new Error(`Too many decimal places: this token supports at most ${decimals}`);
  }

  return BigInt(integerPart + fractionalPart.padEnd(decimals, '0'));
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
  return chalk.green(`✓ ${message}`);
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
  return chalk.yellow(`⚠ ${message}`);
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

/**
 * Extract a short error message from a verbose error
 * Looks for HTTP status codes or returns a truncated message
 */
export function shortErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Failed';
  }

  const message = err.message;

  // Check for "Unexpected response status XXX" pattern (SDK errors)
  const unexpectedMatch = message.match(/Unexpected response status (\d{3})/i);
  if (unexpectedMatch) {
    return `HTTP ${unexpectedMatch[1]}`;
  }

  // Check for HTTP status codes in the message
  const statusMatch = message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch) {
    return `HTTP ${statusMatch[1]}`;
  }

  // Return first line only (no truncation for short messages)
  const firstLine = message.split('\n')[0];
  return firstLine;
}

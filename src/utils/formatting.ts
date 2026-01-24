/**
 * Formatting utilities
 */

import chalk from 'chalk';

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
 * Parse a token amount string to bigint
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const parts = amount.split('.');

  if (parts.length > 2) {
    throw new Error('Invalid amount format');
  }

  const integerPart = parts[0] || '0';
  let fractionalPart = parts[1] || '';

  // Pad or truncate fractional part
  if (fractionalPart.length > decimals) {
    fractionalPart = fractionalPart.slice(0, decimals);
  } else {
    fractionalPart = fractionalPart.padEnd(decimals, '0');
  }

  const combined = integerPart + fractionalPart;
  return BigInt(combined);
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

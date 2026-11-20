/**
 * Token name and symbol come from the token contract, which anyone can deploy and the
 * user adds by address. Treat them as untrusted text: they could carry terminal escape
 * sequences (to rewrite what is on screen), bidi overrides or zero-width characters
 * (to imitate another token), or be absurdly long.
 */

import { sanitizeContractText } from './txErrors.js';

/** Clean a contract-supplied token name for storage and display. */
export function sanitizeTokenName(name: string): string {
  return sanitizeContractText(name, 64) || 'Unnamed token';
}

/** Clean a contract-supplied token symbol for storage and display. */
export function sanitizeTokenSymbol(symbol: string): string {
  return sanitizeContractText(symbol, 16) || '???';
}

/**
 * Parser for the `:` command bar. Pure: turns text into a command; the app decides what
 * to do with it (and checks contacts, tokens and amounts).
 */

import { safeText } from '../cli/utils/userError.js';

/** Screens reachable by name from the command bar. */
export const GO_TARGETS: Record<string, string> = {
  balances: 'balances',
  balance: 'balances',
  b: 'balances',
  receive: 'receive',
  r: 'receive',
  history: 'history',
  h: 'history',
  doctor: 'doctor',
  d: 'doctor',
  settings: 'settings',
  wallets: 'wallets',
  wallet: 'wallets',
  tokens: 'tokens',
  token: 'tokens',
  contacts: 'contacts',
  contact: 'contacts',
  'address book': 'contacts',
  operators: 'operators',
  operator: 'operators',
  find: 'token-find',
  'find tokens': 'token-find',
  unlock: 'unlock',
  network: 'settings-network',
};

/** A parsed command. */
export type Command =
  | { type: 'send'; to?: string; amount?: string; token?: string }
  | { type: 'wrap'; mode: 'wrap' | 'unwrap'; amount?: string; token?: string }
  | { type: 'go'; screen: string }
  | { type: 'lock' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'none' }
  | { type: 'error'; message: string };

/** Examples shown above the command bar while it is open. */
export const COMMAND_EXAMPLES = [
  'send bob 25 cusdc',
  'balances',
  'history',
  'operators',
  'find',
  'network',
  'unlock',
  'lock',
  'help',
];

/**
 * Parse command bar text.
 *
 * `send` takes `<contact|address> <amount> [token]`; with no arguments it opens the send
 * wizard. Other commands take no arguments. Matching is case-insensitive; a leading `:` is
 * ignored so pasting ":send …" works.
 */
export function parseCommand(input: string): Command {
  const text = input.trim().replace(/^:/, '').trim();
  if (text === '') return { type: 'none' };
  const words = text.split(/\s+/);
  const verb = words[0].toLowerCase();

  if (verb === 'send' || verb === 's') {
    const args = words.slice(1);
    if (args.length === 0) return { type: 'send' };
    if (args.length < 2 || args.length > 3) {
      return { type: 'error', message: 'Use: send <contact or address> <amount> [token]' };
    }
    return { type: 'send', to: args[0], amount: args[1], token: args[2] };
  }

  // `wrap [amount] [token]` / `unwrap [amount] [token]` (Phase 5).
  if (verb === 'wrap' || verb === 'unwrap') {
    const args = words.slice(1);
    if (args.length > 2) {
      return { type: 'error', message: `Use: ${verb} [amount] [token]` };
    }
    return { type: 'wrap', mode: verb, amount: args[0], token: args[1] };
  }

  const lower = text.toLowerCase();
  if (GO_TARGETS[lower]) return { type: 'go', screen: GO_TARGETS[lower] };
  if (lower === 'lock' || lower === 'l') return { type: 'lock' };
  if (lower === 'help' || lower === '?') return { type: 'help' };
  if (lower === 'quit' || lower === 'q' || lower === 'exit') return { type: 'quit' };

  return {
    type: 'error',
    // Echo what was typed with URLs cut to their host (a pasted RPC URL carries its key)
    // and unsafe characters removed; the raw text is not kept anywhere.
    message: `Unknown command "${safeText(text, 60)}". Try: send bob 25 cusdc · balances · history · operators · find · network · unlock · lock · help`,
  };
}

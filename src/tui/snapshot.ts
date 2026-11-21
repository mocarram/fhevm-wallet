/**
 * A read-only copy of the local data the screens show (wallets, contacts, tokens,
 * preferences). Screens render from this snapshot instead of reading files, which keeps
 * rendering free of I/O; effects reload it after every change they make.
 */

import { listWallets } from '../core/wallet/WalletManager.js';
import { listTokens, type TokenEntry } from '../core/token/TokenRegistry.js';
import type { NetworkName } from '../core/network/NetworkConfig.js';
import { listAddresses } from '../storage/AddressBook.js';
import { loadConfig } from '../storage/ConfigStore.js';
import { getEnvVar, DATA_DIR } from '../storage/paths.js';
import { listTransactions, type Transaction } from '../storage/TransactionStore.js';
import { loadUiPrefs, type UiPrefs } from '../storage/UiPrefsStore.js';
import { RPC_ENV_KEYS } from '../core/network/rpcSettings.js';
import { stripUnsafeChars } from '../utils/text.js';
import { cachedWrappers } from '../storage/WrapperCache.js';
import { listUnwrapsSafe, type UnwrapEntry } from '../storage/UnwrapStore.js';
import type { WrapperInfo } from '../core/token/wrapper.js';

/** What the screens need from local storage. */
export interface Snapshot {
  wallets: Array<{ name: string; address: string }>;
  defaultWallet?: string;
  contacts: Array<{ name: string; address: string }>;
  /** Tokens tracked on the current network. */
  tokens: TokenEntry[];
  prefs: UiPrefs;
  /** Which optional API keys are set (values are never copied into UI state). */
  keys: { etherscan: boolean; zama: boolean };
  /** Custom RPC URL for the current network, if one is set. */
  customRpc?: string;
  /** Lower-case addresses this wallet has sent to before, for the "first time" note. */
  knownRecipients: string[];
  /** Every other address in this wallet's history (sent to or received from), for look-alikes. */
  counterparties?: string[];
  dataDir: string;
  /** Tracked tokens known to be ERC-20 wrappers (wrappers.json), by lowercase address. */
  wrappers: Record<string, WrapperInfo>;
  /** Unwraps of this wallet on this network that are not finished (unwraps.json). */
  unwraps: UnwrapEntry[];
  /** Local history: recent wraps of this wallet recorded unconfirmed (block 0). */
  unconfirmedWraps: Transaction[];
}

/** Read the snapshot for `network` and the given wallet address (for history-based facts). */
export function loadSnapshot(network: NetworkName, walletAddress?: string): Snapshot {
  const config = loadConfig();
  const txs = walletAddress ? listTransactions({ walletAddress, network, limit: 10_000 }) : [];
  const me = walletAddress?.toLowerCase();
  const knownRecipients = txs
    .filter((t) => t.from.toLowerCase() === me)
    .map((t) => t.to.toLowerCase());
  const counterparties = [
    ...new Set(txs.map((t) => (t.from.toLowerCase() === me ? t.to : t.from).toLowerCase())),
  ];
  return {
    wallets: listWallets().map((w) => ({ name: w.name, address: w.address })),
    defaultWallet: config.defaultWallet || undefined,
    // addressbook.json is user-editable: never let a name carry escapes or invisible text.
    contacts: listAddresses().map((c) => ({ name: stripUnsafeChars(c.name), address: c.address })),
    tokens: listTokens(network),
    prefs: loadUiPrefs(),
    keys: {
      etherscan: Boolean(getEnvVar('ETHERSCAN_API_KEY')),
      zama: Boolean(getEnvVar('ZAMA_MAINNET_API_KEY')),
    },
    customRpc: getEnvVar(RPC_ENV_KEYS[network]),
    knownRecipients,
    counterparties,
    dataDir: DATA_DIR,
    wrappers: safe(() => cachedWrappers(network), {}),
    unwraps: walletAddress ? listUnwrapsSafe({ network, wallet: walletAddress, open: true }) : [],
    unconfirmedWraps: txs.filter((t) => t.type === 'mint' && t.blockNumber === 0),
  };
}

/** A cache read that must never stop the TUI from drawing. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

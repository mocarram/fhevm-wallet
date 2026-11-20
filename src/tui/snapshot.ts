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
import { listTransactions } from '../storage/TransactionStore.js';
import { loadUiPrefs, type UiPrefs } from '../storage/UiPrefsStore.js';
import { RPC_ENV_KEYS } from '../core/network/rpcSettings.js';

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
  dataDir: string;
}

/** Read the snapshot for `network` and the given wallet address (for history-based facts). */
export function loadSnapshot(network: NetworkName, walletAddress?: string): Snapshot {
  const config = loadConfig();
  const knownRecipients = walletAddress
    ? listTransactions({ walletAddress, network, limit: 10_000 })
        .filter((t) => t.from.toLowerCase() === walletAddress.toLowerCase())
        .map((t) => t.to.toLowerCase())
    : [];
  return {
    wallets: listWallets().map((w) => ({ name: w.name, address: w.address })),
    defaultWallet: config.defaultWallet || undefined,
    contacts: listAddresses().map((c) => ({ name: c.name, address: c.address })),
    tokens: listTokens(network),
    prefs: loadUiPrefs(),
    keys: {
      etherscan: Boolean(getEnvVar('ETHERSCAN_API_KEY')),
      zama: Boolean(getEnvVar('ZAMA_MAINNET_API_KEY')),
    },
    customRpc: getEnvVar(RPC_ENV_KEYS[network]),
    knownRecipients,
    dataDir: DATA_DIR,
  };
}

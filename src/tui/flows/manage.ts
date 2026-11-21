/**
 * Effects for Tokens, Address book, Settings, History, Doctor and first-run setup.
 */

import { parseAddressInput } from '../../core/send/recipient.js';
import { addTokenWithInfo, removeToken } from '../../core/token/TokenRegistry.js';
import { describeError, fieldErrorFrom } from '../errors.js';
import { clearProviderForNetwork } from '../../core/network/ProviderFactory.js';
import { RPC_ENV_KEYS } from '../../core/network/rpcSettings.js';
import { DEFAULT_RPC_URLS, type NetworkName } from '../../core/network/NetworkConfig.js';
import { addAddress, removeAddress } from '../../storage/AddressBook.js';
import { updateConfig } from '../../storage/ConfigStore.js';
import { removeEnvVar, saveEnvVar } from '../../storage/paths.js';
import { listTransactions } from '../../storage/TransactionStore.js';
import { loadUiPrefs, saveUiPrefs, type UiPrefs } from '../../storage/UiPrefsStore.js';
import { isValidContactName } from '../../utils/validation.js';
import { shortAddress } from '../../core/send/recipient.js';
import { effect, type Effect } from '../effects.js';
import { open, popTo } from '../nav.js';
import { frame, goHome, isUnlocked, top, type AppState, type HistoryRow } from '../state.js';
import { dimLine, line, seg } from '../text.js';
import { decryptAll, refreshEth, reload } from './data.js';
import { runDoctorChecks } from '../../core/doctor.js';
import type { TokenCheck } from '../../core/token/erc7984Check.js';
import { decryptHistory, HISTORY_LIMIT, toHistoryRow } from './history.js';

function ok(s: AppState, text: string): void {
  s.flash = [line('  ', seg(`✔ ${text}`, 'green'))];
}

function bad(s: AppState, text: string): void {
  s.flash = [line('  ', seg(`✗ ${text}`, 'red'))];
}

/** Add the token in the `tokenAddress` field: read it through the backend, then track it. */
export function addTokenFromInput(s: AppState, then: 'tokens' | 'setup'): Effect[] {
  const parsed = parseAddressInput(s.inputs.tokenAddress ?? '');
  if (!parsed.ok) {
    s.fieldError = [parsed.error, 'Paste the token contract address.'];
    return [];
  }
  return addTokenByAddress(s, parsed.address, then);
}

/** Track a token by address (also used for setup's suggested token). */
export function addTokenByAddress(
  s: AppState,
  address: string,
  then: 'tokens' | 'setup',
): Effect[] {
  const network = s.network;
  if (s.data.tokens.some((t) => t.address.toLowerCase() === address.toLowerCase())) {
    if (then === 'setup') return open(s, 'setup-gas');
    s.fieldError = ['That token is already tracked.', 'Pick another address.'];
    return [];
  }
  s.busy = 'Checking the token contract';
  return [
    effect('add-token', async (deps) => {
      let check: TokenCheck;
      try {
        check = await deps.backend.checkToken(address, network);
      } catch (err) {
        const d = describeError(err, { action: 'token lookup' });
        return (st) => {
          st.busy = null;
          st.fieldError = [
            `Couldn't check that token: ${d.title}`,
            d.hint || 'Check the address and the network.',
          ];
        };
      }
      return (st) => {
        st.busy = null;
        if (!check.compliant) {
          // Not refused outright: the user may know better (an unusual deployment), but
          // they have to say so on a screen that explains what the check found.
          st.tokenCheck = check;
          return open(st, 'token-add-confirm', { then });
        }
        return trackChecked(st, check, then, network);
      };
    }),
  ];
}

/**
 * Track a token whose check is done (passed, or the user chose "Add anyway"). Shows the
 * check's warnings with the success message.
 */
export function trackChecked(
  s: AppState,
  check: TokenCheck,
  then: 'tokens' | 'setup',
  network: NetworkName = s.network,
): Effect[] {
  if (!check.info) {
    s.fieldError = [
      'That contract has no token name, symbol or decimals.',
      'It cannot be tracked. Check the address on a block explorer.',
    ];
    return [];
  }
  let entry;
  try {
    entry = addTokenWithInfo(check.info, network);
  } catch (err) {
    const d = describeError(err, { action: 'token lookup' });
    s.fieldError = [`Couldn't add that token: ${d.title}`, d.hint || 'Check the address.'];
    return [];
  }
  delete s.inputs.tokenAddress;
  s.tokenCheck = null;
  // Esc from the next screen must not land on the answered "Add anyway?" question.
  if (top(s).id === 'token-add-confirm') s.stack.pop();
  // Show it at once; the reload below refreshes the rest of the snapshot.
  if (s.network === network && !s.data.tokens.some((t) => t.address === entry.address)) {
    s.data = { ...s.data, tokens: [...s.data.tokens, entry] };
  }
  const notes = [
    ...check.warnings,
    ...(check.compliant ? [] : ['Added although the ERC-7984 check failed.']),
  ];
  if (then === 'setup') {
    const fx = open(s, 'setup-gas');
    ok(s, `Added ${entry.symbol} (${entry.name})`);
    s.flash!.push(...notes.map((n) => dimLine(`    ${n}`)));
    return [reload(s), ...fx];
  }
  popTo(s, 'tokens');
  ok(s, `Added ${entry.symbol} (${entry.name}) at ${shortAddress(entry.address)}`);
  s.flash!.push(...notes.map((n) => dimLine(`    ${n}`)));
  return [reload(s), ...decryptAll(s)];
}

/** Stop tracking the tokens with these addresses. */
export function removeTrackedTokens(s: AppState, addresses: string[]): Effect[] {
  const network = s.network;
  const symbols = addresses.map(
    (a) => s.data.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase())?.symbol ?? a,
  );
  return [
    effect('remove-tokens', async () => {
      for (const a of addresses) removeToken(a, network);
      return (st) => {
        for (const a of addresses) delete st.balances[a.toLowerCase()];
        popTo(st, 'tokens');
        ok(st, `Stopped tracking ${symbols.join(', ')}. Balances on-chain are unaffected.`);
        return [reload(st)];
      };
    }),
  ];
}

/** Contact name step: validate, then ask for the address (or save a prefilled one). */
export function submitContactName(s: AppState): Effect[] {
  const name = (s.inputs.contactName ?? '').trim();
  if (!isValidContactName(name)) {
    s.fieldError = ['Use 1-32 letters, digits or spaces.', 'For example: bob, Treasury 2.'];
    return [];
  }
  if (s.data.contacts.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    s.fieldError = [`You already have a contact called "${name}".`, 'Pick another name.'];
    return [];
  }
  if (s.stack[s.stack.length - 1].params.address) {
    return saveContact(s, name, s.stack[s.stack.length - 1].params.address);
  }
  return open(s, 'contact-address');
}

/** Contact address step: checksum-checked, then saved. */
export function submitContactAddress(s: AppState): Effect[] {
  const parsed = parseAddressInput(s.inputs.contactAddress ?? '');
  if (!parsed.ok) {
    s.fieldError = [parsed.error, 'Paste the full address, starting with 0x.'];
    return [];
  }
  return saveContact(s, (s.inputs.contactName ?? '').trim(), parsed.address);
}

function saveContact(s: AppState, name: string, address: string): Effect[] {
  return [
    effect('add-contact', async () => {
      try {
        addAddress(name, address);
      } catch (err) {
        const fe = fieldErrorFrom(err, 'Contacts must have unique names and addresses.', {
          fallback: 'Could not save the contact.',
        });
        return (st) => {
          st.fieldError = fe;
        };
      }
      return (st) => {
        delete st.inputs.contactName;
        delete st.inputs.contactAddress;
        if (st.offerSave?.toLowerCase() === address.toLowerCase()) st.offerSave = null;
        if (!popTo(st, 'contacts')) goHome(st);
        ok(st, `Saved ${shortAddress(address)} as "${name}".`);
        return [reload(st)];
      };
    }),
  ];
}

/** Remove a contact. */
export function removeContact(s: AppState, name: string): Effect[] {
  return [
    effect('remove-contact', async () => {
      removeAddress(name);
      return (st) => {
        popTo(st, 'contacts');
        ok(st, `Removed ${name} from your address book.`);
        return [reload(st)];
      };
    }),
  ];
}

/** Switch network (Settings, setup). Balances shown are per network, so they reset. */
export function setNetwork(
  s: AppState,
  network: NetworkName,
  then: 'settings' | 'setup',
): Effect[] {
  return [
    effect('set-network', async () => {
      updateConfig({ defaultNetwork: network });
      return (st) => {
        st.network = network;
        // The decrypt signature is bound to one chain: sign again on the new one.
        st.decryptSession?.clear();
        st.decryptSession = null;
        st.balances = {};
        st.eth = null;
        st.send = {};
        st.history = null;
        st.doctor = null;
        st.offerSave = null;
        const fx = [reload(st), refreshEth(st), ...decryptAll(st)];
        if (then === 'setup') return [...fx, ...open(st, 'setup-token')];
        if (network === 'mainnet') {
          st.flash = [
            line(
              '  ',
              seg(
                '! Switched to Mainnet: real funds. Sends now ask you to retype the amount.',
                'yellow',
              ),
            ),
          ];
        } else ok(st, 'Switched to Sepolia testnet');
        return fx;
      };
    }),
  ];
}

/** Save a preference and reload. */
export function savePrefs(s: AppState, patch: Partial<UiPrefs>, message: string): Effect[] {
  return [
    effect('save-prefs', async () => {
      const prefs = { ...loadUiPrefs(), ...patch };
      saveUiPrefs(prefs);
      return (st) => {
        st.data = { ...st.data, prefs };
        // A shorter unlock duration applies to the current unlock too.
        if (patch.unlockMinutes !== undefined && isUnlocked(st)) {
          const limit = st.now + Math.max(patch.unlockMinutes, 2) * 60_000;
          if (st.unlockedUntil! > limit) st.unlockedUntil = limit;
        }
        ok(st, message);
      };
    }),
  ];
}

/** Next value in a list of choices, wrapping around. */
export function nextChoice<T>(choices: readonly T[], current: T): T {
  const i = choices.indexOf(current);
  return choices[(i + 1) % choices.length];
}

/** Save the API key in the `apiKey` field to the private .env file. */
export function saveApiKey(s: AppState, which: 'etherscan' | 'zama'): Effect[] {
  const value = (s.inputs.apiKey ?? '').trim();
  if (!value) {
    s.fieldError = ['Paste the key first.', 'Or press Esc to leave it unchanged.'];
    return [];
  }
  const envKey = which === 'etherscan' ? 'ETHERSCAN_API_KEY' : 'ZAMA_MAINNET_API_KEY';
  return [
    effect('save-key', async () => {
      try {
        saveEnvVar(envKey, value);
      } catch (err) {
        // The message may quote the key itself; describeError redacts known key values,
        // but this key is not saved yet, so never echo the text.
        void err;
        return (st) => {
          delete st.inputs.apiKey;
          st.fieldError = [
            'That key could not be saved.',
            'Keys may not contain spaces, quotes or #.',
          ];
        };
      }
      return (st) => {
        delete st.inputs.apiKey;
        popTo(st, 'settings');
        ok(st, `Saved. Stored in ${st.data.dataDir}/.env with owner-only access.`);
        return [reload(st)];
      };
    }),
  ];
}

/** Remove an API key from the private .env file. */
export function removeApiKey(s: AppState, which: 'etherscan' | 'zama'): Effect[] {
  const envKey = which === 'etherscan' ? 'ETHERSCAN_API_KEY' : 'ZAMA_MAINNET_API_KEY';
  return [
    effect('remove-key', async () => {
      removeEnvVar(envKey);
      return (st) => {
        popTo(st, 'settings');
        ok(st, 'Key removed.');
        return [reload(st)];
      };
    }),
  ];
}

/** Ask the configured RPC which chain it serves. */
export function checkRpc(s: AppState): Effect[] {
  const network = s.network;
  s.busy = 'Asking the RPC endpoint';
  return [
    effect('check-rpc', async (deps) => {
      try {
        const r = await deps.backend.checkRpc(network);
        return (st) => {
          st.busy = null;
          if (r.chainMatches) ok(st, `RPC answers with chain id ${r.chainId} · ${r.latencyMs} ms`);
          else bad(st, `That RPC serves chain ${r.chainId}, not ${network}. Set another URL.`);
        };
      } catch {
        return (st) => {
          st.busy = null;
          bad(st, 'The RPC endpoint did not answer. Check the URL and your connection.');
        };
      }
    }),
  ];
}

/** Verify and save the custom RPC URL in the `rpcUrl` field. */
export function saveRpcUrl(s: AppState): Effect[] {
  const network = s.network;
  const url = (s.inputs.rpcUrl ?? '').trim();
  if (!url) {
    s.fieldError = ['Paste an https:// URL first.', 'Or press Esc to keep the current one.'];
    return [];
  }
  s.busy = 'Checking the endpoint serves the right chain';
  return [
    effect('set-rpc', async (deps) => {
      try {
        const probe = await deps.backend.setCustomRpc(network, url);
        return (st) => {
          st.busy = null;
          delete st.inputs.rpcUrl;
          popTo(st, 'settings-rpc');
          ok(
            st,
            deps.backend.kind === 'mock'
              ? `Checked: it answers with chain id ${probe.chainId} in ${probe.latencyMs} ms. Not saved: the offline mock never changes RPC settings.`
              : `Saved. It answers with chain id ${probe.chainId} in ${probe.latencyMs} ms.`,
          );
          return [reload(st)];
        };
      } catch (err) {
        const d = describeError(err, { action: 'RPC check', fallback: 'Could not use that URL.' });
        return (st) => {
          st.busy = null;
          st.fieldError = [d.title, d.hint ? `${d.hint} Nothing was saved.` : 'Nothing was saved.'];
        };
      }
    }),
  ];
}

/** Drop the custom RPC URL and use the defaults (with fallbacks) again. */
export function resetRpc(s: AppState): Effect[] {
  const network = s.network;
  return [
    effect('reset-rpc', async () => {
      removeEnvVar(RPC_ENV_KEYS[network]);
      clearProviderForNetwork(network);
      return (st) => {
        ok(st, `Using the default RPC again: ${DEFAULT_RPC_URLS[network]} (with fallbacks)`);
        return [reload(st)];
      };
    }),
  ];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 19 14:02" in local time. */
export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

/** Load history: show local rows at once, then sync through the backend. */
export function loadHistory(s: AppState): Effect[] {
  const wallet = s.wallet;
  if (!wallet) return [];
  const network = s.network;
  const tokens = s.data.tokens;
  const names = new Map(s.data.contacts.map((c) => [c.address.toLowerCase(), c.name]));
  const rows = (): HistoryRow[] =>
    listTransactions({ walletAddress: wallet.address, network, limit: HISTORY_LIMIT }).map((t) =>
      toHistoryRow(t, wallet.address, names, tokens),
    );
  s.history = { rows: s.history?.rows ?? [], loading: true };
  return [
    effect('history', async (deps) => {
      const local = rows();
      deps.dispatch((st) => {
        if (st.history) st.history.rows = local;
      });
      try {
        await deps.backend.syncHistory(wallet.address, network, tokens);
        const synced = rows();
        return (st) => {
          st.history = { rows: synced, loading: false };
          // Unlocked: decrypt the new amounts in the background.
          return decryptHistory(st);
        };
      } catch (err) {
        const msg = describeError(err, { action: 'history sync' }).title;
        return (st) => {
          st.history = {
            rows: local,
            loading: false,
            error: `Couldn't sync: ${msg} Showing what is saved locally.`,
          };
          return decryptHistory(st);
        };
      }
    }),
  ];
}

export { nodeVersionOk } from '../../core/doctor.js';

/** Run the Doctor checks (core/doctor.ts) through the backend. */
export function runDoctor(s: AppState): Effect[] {
  const network = s.network;
  const address = s.wallet?.address;
  const data = s.data;
  s.doctor = null;
  return [
    effect('doctor', async (deps) => {
      const rows = await runDoctorChecks({
        backend: deps.backend,
        network,
        address,
        tokens: data.tokens,
        dataDir: data.dataDir,
        etherscanKey: data.keys.etherscan,
      });
      return (st) => {
        if (st.network === network) st.doctor = rows;
      };
    }),
  ];
}

/** First-run setup's last step: checks and ETH. */
export function setupChecks(s: AppState): Effect[] {
  return [...runDoctor(s), refreshEth(s)];
}

/** Finish first-run setup and land on Home. */
export function finishSetup(s: AppState): Effect[] {
  s.setup = false;
  s.stack = [frame('home')];
  s.flash = [
    line('  ', seg("✔ You're set up.", 'green bold')),
    dimLine('    Press s to send, : for the command bar, or ? for help.'),
  ];
  return [reload(s), ...decryptAll(s)];
}

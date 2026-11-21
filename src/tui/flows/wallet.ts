/**
 * Wallet effects: unlock, create, import, switch, export and remove. Keystores are always
 * the real encrypted files under the data directory, also with the mock backend.
 */

import { Wallet } from 'ethers';
import { homedir } from 'os';
import { join } from 'path';
import {
  createWallet,
  exportKeystoreFile,
  exportWalletPrivateKey,
  importWalletFromMnemonic,
  importWalletFromPrivateKey,
  loadWallet,
  removeWallet,
} from '../../core/wallet/WalletManager.js';
import { getDefaultWallet, setDefaultWallet, updateConfig } from '../../storage/ConfigStore.js';
import { formatPhrase } from '../../cli/utils/secretScreen.js';
import { effect, type Effect } from '../effects.js';
import { frame, clearSecrets, goHome, lockWallet, type AppState } from '../state.js';
import { line, seg } from '../text.js';
import { errorLines, fieldErrorFrom } from '../errors.js';
import { decryptAll, refreshEth, reload } from './data.js';
import { decryptHistory } from './history.js';
import { popTo } from '../nav.js';

/** How long an unlock lasts, from the "Stay unlocked for" setting. */
export function unlockDurationMs(minutes: number): number {
  // "Every action": keep it for a short grace period so the action that asked for the
  // password can finish; decrypt and send lock again as soon as they are done.
  return (minutes === 0 ? 2 : minutes) * 60_000;
}

/** Where to go after a successful unlock. */
export type AfterUnlock = 'balances' | 'history' | 'review' | 'none';

/**
 * Decrypt the current wallet's keystore with the password in the `unlock` field. The key
 * stays in memory only. On success the unlock screen closes and `after` decides what runs
 * next; on failure the field shows why.
 */
export function unlock(
  s: AppState,
  after: AfterUnlock,
  onReview?: (st: AppState) => Effect[],
): Effect[] {
  const wallet = s.wallet;
  const password = s.inputs.unlock ?? '';
  if (!wallet) return [];
  if (!password) {
    s.fieldError = ['Type your wallet password.', 'It is the password you chose when creating it.'];
    return [];
  }
  s.busy = 'Unlocking';
  // The screen that asked. If the user leaves it (Esc, Ctrl+C) before the keystore is
  // decrypted, the unlock is abandoned: nobody is waiting for it any more.
  const requester = s.stack[s.stack.length - 1];
  return [
    effect('unlock', async (deps) => {
      try {
        const signer = await loadWallet(wallet.name, password);
        return (st) => {
          delete st.inputs.unlock;
          if (st.stack[st.stack.length - 1] !== requester) return;
          st.busy = null;
          if (st.wallet?.address !== wallet.address) return;
          st.signer = signer;
          st.unlockedUntil = deps.now() + unlockDurationMs(st.data.prefs.unlockMinutes);
          if (st.stack.length > 1) st.stack.pop();
          if (after === 'review' && onReview) return onReview(st);
          // Every unlock refreshes balances in the background (one signature for all).
          if (after === 'history') return [...decryptAll(st), ...decryptHistory(st)];
          return decryptAll(st);
        };
      } catch {
        return (st) => {
          delete st.inputs.unlock;
          if (st.stack[st.stack.length - 1] !== requester) return;
          st.busy = null;
          st.fieldError = [
            `That password did not unlock ${wallet.name}.`,
            'Check it and try again. Nothing was signed.',
          ];
        };
      }
    }),
  ];
}

/** What a create/import wizard collected. */
interface NewWalletInput {
  flow: 'create' | 'import';
  /** Set by the setup wizard: continue with Network after the wallet exists. */
  setup: boolean;
  name: string;
  password: string;
  importKind?: 'phrase' | 'key';
  secret?: string;
}

/**
 * Create or import the wallet, show a new recovery phrase on the wipe-on-keypress secret
 * screen, make it the current wallet and continue (setup → Network, else → Wallets).
 */
export function finishNewWallet(s: AppState, input: NewWalletInput): Effect[] {
  s.busy =
    input.flow === 'create'
      ? 'Creating and encrypting your wallet'
      : 'Importing and encrypting your wallet';
  clearSecrets(s);
  return [
    effect('new-wallet', async (deps) => {
      let address: string;
      let signer: Wallet | ReturnType<typeof Wallet.fromPhrase> | null = null;
      try {
        if (input.flow === 'create') {
          const created = await createWallet(input.name, input.password);
          address = created.address;
          // Shown once, on the screen that is wiped from scrollback by the next key.
          await deps.showSecret(
            `Recovery phrase for ${input.name}`,
            formatPhrase(created.mnemonic),
          );
          signer = Wallet.fromPhrase(created.mnemonic);
        } else if (input.importKind === 'phrase') {
          address = await importWalletFromMnemonic(
            input.name,
            input.secret!.trim(),
            input.password,
          );
          signer = Wallet.fromPhrase(input.secret!.trim());
        } else {
          address = await importWalletFromPrivateKey(
            input.name,
            input.secret!.trim(),
            input.password,
          );
          signer = new Wallet(input.secret!.trim());
        }
        // A new wallet becomes the default when there is none (or during setup).
        if (input.setup || !getDefaultWallet()) setDefaultWallet(input.name);
      } catch (err) {
        const lines = errorLines(err, { fallback: 'Could not save the wallet.' });
        return (st) => {
          st.busy = null;
          st.flash = lines;
        };
      }
      const now = deps.now();
      return (st) => {
        st.busy = null;
        st.wallet = { name: input.name, address };
        st.balances = {};
        st.eth = null;
        st.send = {};
        st.history = null;
        if (input.setup) {
          // The setup unlocks the new wallet so the first balances need no extra password.
          st.signer = signer;
          st.unlockedUntil = now + unlockDurationMs(st.data.prefs.unlockMinutes);
          st.stack = [frame('setup-network')];
          st.flash = [line('  ', seg(`✔ ${input.name} is ready: ${address}`, 'green'))];
          return [reload(st), refreshEth(st)];
        }
        lockWallet(st);
        popTo(st, 'wallets');
        st.flash = [
          line(
            '  ',
            seg(
              `✔ ${input.flow === 'create' ? 'Created' : 'Imported'} ${input.name}. Now using it (locked).`,
              'green',
            ),
          ),
        ];
        return [reload(st), refreshEth(st)];
      };
    }),
  ];
}

/** Make another wallet the current one. It starts locked. */
export function switchWallet(s: AppState, name: string): Effect[] {
  const target = s.data.wallets.find((w) => w.name === name);
  if (!target) return [];
  return [
    effect('switch-wallet', async () => {
      setDefaultWallet(name);
      return (st) => {
        lockWallet(st);
        st.wallet = target;
        st.balances = {};
        st.eth = null;
        st.send = {};
        st.history = null;
        st.offerSave = null;
        popTo(st, 'wallets');
        st.flash = [line('  ', seg(`✔ Now using ${name} (locked)`, 'green'))];
        return [reload(st), refreshEth(st)];
      };
    }),
  ];
}

/** Ask for the password, then show the private key on the wipe-on-keypress screen. */
export function exportPrivateKey(s: AppState): Effect[] {
  const wallet = s.wallet;
  const password = s.inputs.password ?? '';
  if (!wallet) return [];
  if (!password) {
    s.fieldError = ['Type your wallet password.', 'The key is decrypted only to show it.'];
    return [];
  }
  s.busy = 'Decrypting';
  return [
    effect('export-key', async (deps) => {
      let key: string;
      try {
        key = await exportWalletPrivateKey(wallet.name, password);
      } catch {
        return (st) => {
          st.busy = null;
          delete st.inputs.password;
          st.fieldError = [
            `That password did not unlock ${wallet.name}.`,
            'Check it and try again.',
          ];
        };
      }
      await deps.showSecret(`Private key for ${wallet.name}`, [key]);
      key = '';
      return (st) => {
        st.busy = null;
        delete st.inputs.password;
        popTo(st, 'wallets');
        st.flash = [line('  ', seg('✔ Screen wiped. The key is not in your scrollback.', 'green'))];
      };
    }),
  ];
}

/** Default file name offered for an encrypted keystore export. */
export function defaultKeystorePath(name: string): string {
  return join(homedir(), `${name}-keystore.json`);
}

/** Copy the encrypted keystore to the path in the `exportPath` field (never overwrites). */
export function exportKeystore(s: AppState): Effect[] {
  const wallet = s.wallet;
  if (!wallet) return [];
  const target = (s.inputs.exportPath ?? '').trim() || defaultKeystorePath(wallet.name);
  return [
    effect('export-keystore', async () => {
      try {
        const saved = exportKeystoreFile(wallet.name, target.replace(/^~(?=$|\/)/, homedir()));
        return (st) => {
          popTo(st, 'wallets');
          st.flash = [
            line('  ', seg(`✔ Saved ${saved} (encrypted with your wallet password)`, 'green')),
          ];
        };
      } catch (err) {
        const fe = fieldErrorFrom(err, 'Choose another file name.', { fallback: 'Export failed.' });
        return (st) => {
          st.fieldError = fe;
        };
      }
    }),
  ];
}

/** Remove the current wallet after its name was typed to confirm. */
export function removeCurrentWallet(s: AppState): Effect[] {
  const wallet = s.wallet;
  if (!wallet) return [];
  if ((s.inputs.confirmName ?? '').trim() !== wallet.name) {
    s.fieldError = [
      `Type ${wallet.name} exactly to remove it.`,
      'This deletes the keystore from this computer.',
    ];
    return [];
  }
  return [
    effect('remove-wallet', async () => {
      removeWallet(wallet.name);
      if (getDefaultWallet() === wallet.name) updateConfig({ defaultWallet: undefined });
      return (st) => {
        delete st.inputs.confirmName;
        lockWallet(st);
        const rest = st.data.wallets.filter((w) => w.name !== wallet.name);
        st.balances = {};
        st.eth = null;
        st.send = {};
        st.history = null;
        if (rest.length === 0) {
          st.wallet = null;
          st.setup = true;
          st.stack = [frame('setup-welcome')];
          st.flash = [
            line(
              '  ',
              seg(`✔ Removed ${wallet.name}. Create or import a wallet to continue.`, 'green'),
            ),
          ];
          return [reload(st)];
        }
        st.wallet = rest[0];
        goHome(st);
        st.stack.push(frame('wallets'));
        st.flash = [
          line('  ', seg(`✔ Removed ${wallet.name}. Now using ${rest[0].name} (locked).`, 'green')),
        ];
        return [
          reload(st),
          refreshEth(st),
          effect('set-default', async () => {
            setDefaultWallet(rest[0].name);
          }),
        ];
      };
    }),
  ];
}

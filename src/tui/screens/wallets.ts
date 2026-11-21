/**
 * Wallets: list, switch, create, import, export (private key on the wipe-on-keypress
 * screen, or the encrypted keystore file) and remove (type the name to confirm).
 * The create/import wizard screens are shared with first-run setup (`params.setup`).
 */

import {
  isValidMnemonic,
  isValidPrivateKey,
  isValidWalletName,
  passwordStrengthHint,
} from '../../utils/validation.js';
import { shortAddress } from '../../core/send/recipient.js';
import { open } from '../nav.js';
import type { Item, ScreenDef } from '../screen.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, pad, seg, type Line } from '../text.js';
import {
  defaultKeystorePath,
  exportKeystore,
  exportPrivateKey,
  exportRecoveryPhrase,
  finishNewWallet,
  removeCurrentWallet,
  switchWallet,
} from '../flows/wallet.js';
import { backItem, BLANK, inputLine, SEP, stepper, SETUP_STEPS } from './common.js';

function params(s: AppState) {
  return top(s).params;
}

function wizardHead(s: AppState, title: string): Line[] {
  return params(s).setup
    ? [stepper(0, SETUP_STEPS), BLANK, line('  ', seg(title, 'bold'))]
    : [line('  ', seg(title, 'bold'))];
}

function crumbFor(step: string): string[] {
  return ['Wallets', step];
}

export const walletsScreen: ScreenDef = {
  crumb: ['Wallets'],
  view: (s) => {
    const body = s.data.wallets.map((w) => {
      const current = w.address === s.wallet?.address;
      return line(
        '  ',
        current ? seg('● ', 'green') : seg('○ ', 'dim'),
        seg(pad(w.name, 12), 'bold'),
        ' ',
        seg(shortAddress(w.address), 'dim'),
        current ? seg('   in use', 'dim') : '',
      );
    });
    const name = s.wallet?.name ?? '';
    return {
      body,
      items: [
        { label: 'Switch wallet', act: (st) => open(st, 'wallet-switch') },
        { label: 'Create new wallet', act: (st) => startWizard(st, 'create') },
        { label: 'Import wallet', act: (st) => open(st, 'wallet-import-type', { flow: 'import' }) },
        {
          label: `Back up ${name}`,
          note: 'key, recovery phrase or keystore file',
          act: (st) => open(st, 'export-confirm'),
        },
        {
          label: `Remove ${name}`,
          act: (st) => {
            delete st.inputs.confirmName;
            return open(st, 'wallet-remove');
          },
        },
        backItem(),
      ],
      hint: '↑↓ move · enter select · esc back',
    };
  },
};

/** Start the create wizard (also from setup). */
export function startWizard(s: AppState, flow: 'create', setup = false) {
  delete s.inputs.walletName;
  return open(s, 'wallet-name', { flow, setup: setup ? '1' : '' });
}

export const walletSwitchScreen: ScreenDef = {
  crumb: crumbFor('Switch'),
  view: (s) => ({
    body: [dimLine('  Pick the wallet to use. It starts locked.')],
    items: [
      ...s.data.wallets.map<Item>((w) => ({
        label: `${pad(w.name, 12)} ${shortAddress(w.address)}`,
        value: w.address === s.wallet?.address ? 'in use' : '',
        valueStyle: 'dim',
        act: (st) => switchWallet(st, w.name),
      })),
      SEP,
      backItem(),
    ],
    hint: '↑↓ move · enter switch · esc back',
  }),
};

const NAME_SPEC = {
  field: 'walletName',
  placeholder: 'e.g. alice',
  accept: /^[a-zA-Z0-9_-]$/,
  maxLength: 32,
};

export const walletNameScreen: ScreenDef = {
  crumb: crumbFor('Name'),
  view: (s) => ({
    body: [
      ...wizardHead(s, 'Name this wallet'),
      BLANK,
      inputLine(s, NAME_SPEC),
      BLANK,
      dimLine('  Letters, digits, - and _. Only you see it.'),
    ],
    input: NAME_SPEC,
    items: [
      {
        label: 'Continue',
        act: (st) => {
          const name = st.inputs.walletName ?? '';
          if (!isValidWalletName(name)) {
            st.fieldError = ['Use 1-32 letters, digits, - or _.', 'For example: alice, savings_2.'];
            return;
          }
          if (st.data.wallets.some((w) => w.name === name)) {
            st.fieldError = [`You already have a wallet called "${name}".`, 'Pick another name.'];
            return;
          }
          return open(st, 'wallet-password', { ...params(st) });
        },
      },
      backItem(),
    ],
    hint: 'type a name · enter continue · esc back',
  }),
};

const PW_SPEC = { field: 'password', secret: true, placeholder: 'at least 8 characters' };
const PW2_SPEC = { field: 'password2', secret: true, placeholder: 'type it again' };

export const walletPasswordScreen: ScreenDef = {
  crumb: crumbFor('Password'),
  view: (s) => ({
    body: [
      ...wizardHead(s, `Choose a password for ${s.inputs.walletName ?? ''}`),
      BLANK,
      inputLine(s, PW_SPEC),
      BLANK,
      dimLine('  It encrypts the key on this computer. There is no way to reset it.'),
    ],
    input: PW_SPEC,
    items: [
      {
        label: 'Continue',
        act: (st) => {
          const pw = st.inputs.password ?? '';
          if (pw.length < 8) {
            st.fieldError = [
              'Use at least 8 characters.',
              'A few random words make a strong password.',
            ];
            return;
          }
          delete st.inputs.password2;
          const fx = open(st, 'wallet-password2', { ...params(st) });
          // Soft advice only; it never blocks.
          const hint = passwordStrengthHint(pw);
          if (hint) st.flash = [line('  ', seg(hint, 'yellow'))];
          return fx;
        },
      },
      backItem(),
    ],
    hint: 'type password · enter continue · esc back',
  }),
};

export const walletPassword2Screen: ScreenDef = {
  crumb: crumbFor('Password'),
  view: (s) => ({
    body: [...wizardHead(s, 'Type the password again'), BLANK, inputLine(s, PW2_SPEC)],
    input: PW2_SPEC,
    items: [
      {
        label: params(s).flow === 'import' ? 'Import wallet' : 'Create wallet',
        act: (st) => {
          if ((st.inputs.password2 ?? '') !== (st.inputs.password ?? '')) {
            delete st.inputs.password2;
            st.fieldError = [
              "The passwords don't match.",
              'Type the same password again, or Esc to change it.',
            ];
            return;
          }
          const p = params(st);
          return finishNewWallet(st, {
            flow: p.flow === 'import' ? 'import' : 'create',
            setup: Boolean(p.setup),
            name: st.inputs.walletName ?? '',
            password: st.inputs.password ?? '',
            importKind: p.kind === 'key' ? 'key' : 'phrase',
            secret: st.inputs.importSecret,
          });
        },
      },
      backItem(),
    ],
    hint: 'type password · enter continue · esc back',
  }),
};

export const walletImportTypeScreen: ScreenDef = {
  crumb: crumbFor('Import'),
  view: (s) => ({
    body: wizardHead(s, 'Import from'),
    items: [
      { label: 'Recovery phrase (12 or 24 words)', act: (st) => importSecret(st, 'phrase') },
      { label: 'Private key', act: (st) => importSecret(st, 'key') },
      backItem(),
    ],
    hint: '↑↓ move · enter select · esc back',
  }),
};

function importSecret(s: AppState, kind: 'phrase' | 'key') {
  delete s.inputs.importSecret;
  return open(s, 'wallet-import-secret', { ...params(s), kind });
}

export const walletImportSecretScreen: ScreenDef = {
  crumb: crumbFor('Import'),
  view: (s) => {
    const kind = params(s).kind === 'key' ? 'key' : 'phrase';
    const spec = {
      field: 'importSecret',
      secret: true,
      placeholder: kind === 'key' ? '0x… (64 hex characters)' : 'words separated by spaces',
    };
    return {
      body: [
        ...wizardHead(
          s,
          kind === 'key' ? 'Paste the private key' : 'Type or paste the recovery phrase',
        ),
        BLANK,
        inputLine(s, spec),
        BLANK,
        dimLine(
          '  Hidden as you type. It is encrypted with your new password and never stored in plain text.',
        ),
      ],
      input: spec,
      items: [
        {
          label: 'Continue',
          act: (st) => {
            const v = (st.inputs.importSecret ?? '').trim().replace(/\s+/g, ' ');
            const valid = kind === 'key' ? isValidPrivateKey(v) : isValidMnemonic(v);
            if (!valid) {
              st.fieldError =
                kind === 'key'
                  ? [
                      'That is not a private key.',
                      'It is 64 hex characters, optionally starting with 0x.',
                    ]
                  : ['That phrase is not valid.', 'Check the words and their order.'];
              return;
            }
            st.inputs.importSecret = v;
            delete st.inputs.walletName;
            return open(st, 'wallet-name', { ...params(st), flow: 'import', kind });
          },
        },
        backItem(),
      ],
      hint: 'paste · enter continue · esc back',
    };
  },
};

export const exportConfirmScreen: ScreenDef = {
  crumb: crumbFor('Back up'),
  view: (s) => ({
    body: [
      line(
        '  ',
        seg(`Your private key gives full control of ${s.wallet?.name ?? ''}.`, 'yellow bold'),
      ),
      dimLine('  Key and phrase open on a separate screen that is wiped when you press Enter,'),
      dimLine('  so they do not stay in your terminal scrollback.'),
      BLANK,
      dimLine('  Safer option: export an encrypted keystore file instead.'),
    ],
    items: [
      {
        label: 'Show key on a private screen',
        act: (st) => {
          delete st.inputs.password;
          return open(st, 'export-password');
        },
      },
      {
        label: 'Export encrypted keystore file',
        act: (st) => {
          st.inputs.exportPath = defaultKeystorePath(st.wallet?.name ?? 'wallet');
          return open(st, 'export-keystore');
        },
      },
      {
        label: 'Show recovery phrase on a private screen',
        act: (st) => {
          delete st.inputs.password;
          return open(st, 'export-password', { what: 'phrase' });
        },
      },
      backItem('Cancel'),
    ],
    hint: 'enter select · esc back',
  }),
};

const EXPORT_PW = { field: 'password', secret: true, placeholder: 'your wallet password' };

export const exportPasswordScreen: ScreenDef = {
  crumb: crumbFor('Back up'),
  view: (s) => ({
    body: [
      line('  Password for ', seg(s.wallet?.name ?? '', 'bold')),
      BLANK,
      inputLine(s, EXPORT_PW),
    ],
    input: EXPORT_PW,
    items: [
      top(s).params.what === 'phrase'
        ? { label: 'Show recovery phrase', act: exportRecoveryPhrase }
        : { label: 'Show key', act: exportPrivateKey },
      backItem(),
    ],
    hint: 'type password · enter show · esc back',
  }),
};

const PATH_SPEC = { field: 'exportPath', placeholder: 'file path' };

export const exportKeystoreScreen: ScreenDef = {
  crumb: crumbFor('Export keystore'),
  view: (s) => ({
    body: [
      line('  Save the encrypted keystore of ', seg(s.wallet?.name ?? '', 'bold'), ' to:'),
      BLANK,
      inputLine(s, PATH_SPEC),
      BLANK,
      dimLine(
        '  It stays protected by your wallet password. Existing files are never overwritten.',
      ),
    ],
    input: PATH_SPEC,
    items: [{ label: 'Save file', act: exportKeystore }, backItem()],
    hint: 'edit path · enter save · esc back',
  }),
};

const CONFIRM_SPEC = { field: 'confirmName', placeholder: 'wallet name' };

export const walletRemoveScreen: ScreenDef = {
  crumb: crumbFor('Remove'),
  view: (s) => ({
    body: [
      line('  ', seg(`Remove ${s.wallet?.name ?? ''} from this computer?`, 'yellow bold')),
      dimLine('  Without its recovery phrase or a keystore backup, its funds are lost.'),
      BLANK,
      line(`  Type ${s.wallet?.name ?? ''} to confirm:`),
      inputLine(s, CONFIRM_SPEC),
    ],
    input: CONFIRM_SPEC,
    items: [
      { label: `Remove ${s.wallet?.name ?? ''}`, act: removeCurrentWallet },
      backItem('Cancel'),
    ],
    hint: 'type the name · enter remove · esc cancel',
  }),
};

/**
 * First-run setup: Wallet → Network → Token → Gas. Shown when no wallet exists. The
 * wallet step reuses the Wallets create/import wizard (with `setup` set), so there is one
 * implementation of key creation, password checks and the recovery-phrase screen.
 */

import { effect } from '../effects.js';
import {
  addTokenByAddress,
  finishSetup,
  runDoctor,
  setNetwork,
  setupChecks,
} from '../flows/manage.js';
import { refreshEth } from '../flows/data.js';
import { formatEth, spinner } from '../format.js';
import { open } from '../nav.js';
import { QUIT } from '../effects.js';
import type { Item, MenuEntry, ScreenDef } from '../screen.js';
import type { AppState } from '../state.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { backItem, BLANK, SEP, SETUP_STEPS, stepper } from './common.js';
import { doctorLines } from './doctor.js';
import { copyAddressItem, SEPOLIA_FAUCETS } from './receive.js';
import { startWizard } from './wallets.js';

export const setupWelcomeScreen: ScreenDef = {
  crumb: ['Setup'],
  view: () => ({
    body: [
      stepper(0, SETUP_STEPS),
      BLANK,
      line('  ', seg('Welcome to fhEVM Wallet.', 'bold')),
      BLANK,
      line('  Confidential tokens keep balances and amounts encrypted on-chain.'),
      line('  Only you, and whoever you send to, can decrypt them.'),
      BLANK,
      dimLine('  Setup takes about two minutes. You can leave and come back.'),
    ],
    items: [
      { label: 'Create a new wallet', act: (st) => startWizard(st, 'create', true) },
      {
        label: 'Import a wallet I already have',
        act: (st) => open(st, 'wallet-import-type', { flow: 'import', setup: '1' }),
      },
      SEP,
      { label: 'Quit', key: 'q', zero: true, act: () => [QUIT] },
    ],
    hint: '↑↓ move · enter select · ? help · 0 quit',
  }),
};

export const setupNetworkScreen: ScreenDef = {
  crumb: ['Setup', 'Network'],
  view: () => ({
    body: [stepper(1, SETUP_STEPS), BLANK, line('  Which network do you want to start on?')],
    items: [
      {
        label: 'Sepolia testnet',
        value: 'free test funds · recommended',
        valueStyle: 'green',
        act: (st) => setNetwork(st, 'sepolia', 'setup'),
      },
      {
        label: 'Ethereum Mainnet',
        value: 'real funds · needs a Zama API key',
        valueStyle: 'yellow',
        act: (st) => setNetwork(st, 'mainnet', 'setup'),
      },
      SEP,
      { label: 'Quit', key: 'q', zero: true, act: () => [QUIT] },
    ],
    hint: '↑↓ move · enter select · 0 quit (setup continues next time)',
  }),
};

export const setupTokenScreen: ScreenDef = {
  crumb: ['Setup', 'Token'],
  onEnter: (s) => {
    const network = s.network;
    return [
      effect('suggest-tokens', async (deps) => {
        const list = deps.backend.suggestedTokens(network);
        return (st) => {
          st.suggested = list;
        };
      }),
    ];
  },
  view: (s) => {
    const items: MenuEntry[] = (s.suggested ?? [])
      .filter(
        (t) => !s.data.tokens.some((x) => x.address.toLowerCase() === t.address.toLowerCase()),
      )
      .map<Item>((t) => ({
        label: `${t.symbol}  ${t.name}`,
        value: 'suggested',
        valueStyle: 'green',
        act: (st) => addTokenByAddress(st, t.address, 'setup'),
      }));
    items.push(
      {
        label: 'Paste a token address',
        act: (st) => {
          delete st.inputs.tokenAddress;
          return open(st, 'token-add', { setup: '1' });
        },
      },
      {
        label: s.data.tokens.length ? 'Continue' : 'Skip for now',
        act: (st) => open(st, 'setup-gas'),
      },
      backItem(),
    );
    const body: Line[] = [
      stepper(2, SETUP_STEPS),
      BLANK,
      line('  Add a confidential (ERC-7984) token to track. You can add more later.'),
    ];
    if (s.data.tokens.length) {
      body.push(dimLine(`  Tracking: ${s.data.tokens.map((t) => t.symbol).join(', ')}`));
    }
    return { body, items, hint: '↑↓ move · enter select · esc back' };
  },
};

function gasLines(s: AppState): Line[] {
  if (!s.eth) return [line('  ', seg(`${spinner(s.now)} Checking your ETH for gas…`, 'cyan'))];
  if (s.eth.wei > 0n) {
    return [
      line(
        '  ',
        seg('✔', 'green'),
        ` ${formatEth(s.eth.wei)} ETH available. You're ready to send.`,
      ),
    ];
  }
  return [line('  ', seg('!', 'yellow'), ' 0 ETH. Every send needs a little ETH for gas.')];
}

export const setupGasScreen: ScreenDef = {
  crumb: ['Setup', 'Gas'],
  onEnter: setupChecks,
  view: (s) => {
    const funded = s.eth !== null && s.eth.wei > 0n;
    const checks = s.doctor
      ? doctorLines(s.doctor.filter((r) => r.status !== 'info'))
      : [line('  ', seg(`${spinner(s.now)} Checking your setup…`, 'cyan'))];
    const body: Line[] = [
      stepper(3, SETUP_STEPS),
      BLANK,
      ...checks,
      BLANK,
      ...gasLines(s),
      BLANK,
      line('  Your address  ', seg(s.wallet?.address ?? '', 'bold')),
    ];
    if (!funded && s.network === 'sepolia') {
      body.push(BLANK, dimLine('  Get free Sepolia ETH from a faucet, then check again:'));
      for (const u of SEPOLIA_FAUCETS) body.push(line(seg(`    ${u}`, 'cyan')));
    }
    if (funded)
      body.push(BLANK, dimLine('  Next: s sends, : opens the command bar, ? shows help.'));
    const items: Item[] = funded
      ? [{ label: 'Finish setup', act: finishSetup }, backItem()]
      : [
          copyAddressItem(),
          {
            label: 'Check again',
            act: (st) => [refreshEth(st), ...runDoctor(st)],
          },
          { label: 'Finish without ETH', act: finishSetup },
          backItem(),
        ];
    return { body, items, hint: '↑↓ move · enter select · esc back' };
  },
};

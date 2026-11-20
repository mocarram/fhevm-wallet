/**
 * Settings: network, wallet, RPC endpoint (checked with setCustomRpc before it is saved),
 * Etherscan and Zama API keys (stored in the owner-only .env, never shown), how long an
 * unlock lasts and the send countdown.
 */

import { DEFAULT_RPC_URLS } from '../../core/network/NetworkConfig.js';
import { COUNTDOWN_CHOICES, UNLOCK_MINUTES_CHOICES } from '../../storage/UiPrefsStore.js';
import { MAINNET_MIN_COUNTDOWN } from '../flows/send.js';
import {
  checkRpc,
  nextChoice,
  removeApiKey,
  resetRpc,
  saveApiKey,
  savePrefs,
  saveRpcUrl,
  setNetwork,
} from '../flows/manage.js';
import { open } from '../nav.js';
import type { InputSpec, Item, ScreenDef } from '../screen.js';
import { top, type AppState } from '../state.js';
import { dimLine, line, pad, seg } from '../text.js';
import { backItem, BLANK, inputLine, SEP } from './common.js';

/** "every action", "5 min", "1 hour". */
export function unlockChoiceText(minutes: number): string {
  if (minutes === 0) return 'every action';
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} min`;
}

/** "off", "5 s". */
export function countdownChoiceText(seconds: number): string {
  return seconds === 0 ? 'off' : `${seconds} s`;
}

/**
 * Show an RPC URL without anything that could be a provider key: scheme and host only,
 * with "/…" when there was more.
 */
export function displayRpcUrl(url: string): string {
  const m = url.match(/^(https?:\/\/[^/?#\s]+)(.*)$/i);
  if (!m) return 'custom URL';
  const host = m[1].replace(/\/\/[^@/]*@/, '//'); // never show user:password@
  return m[2] && m[2] !== '/' ? `${host}/…` : host;
}

function row(label: string, value: string, valueStyle: string, act: Item['act']): Item {
  return { label: pad(label, 20), value, valueStyle, act };
}

export const settingsScreen: ScreenDef = {
  crumb: ['Settings'],
  view: (s) => {
    const p = s.data.prefs;
    const items = [
      row(
        'Network',
        s.network === 'mainnet' ? 'Mainnet' : 'Sepolia',
        s.network === 'mainnet' ? 'red' : 'cyan',
        (st) => open(st, 'settings-network'),
      ),
      row('Wallet', s.wallet?.name ?? 'none', '', (st) => open(st, 'wallets')),
      row('RPC endpoint', s.data.customRpc ? 'custom' : 'default', '', (st) =>
        open(st, 'settings-rpc'),
      ),
      row(
        'Etherscan key',
        s.data.keys.etherscan ? 'set' : 'not set',
        s.data.keys.etherscan ? 'green' : 'yellow',
        (st) => openKey(st, 'etherscan'),
      ),
      row(
        'Zama mainnet key',
        s.data.keys.zama ? 'set' : 'not set',
        s.data.keys.zama ? 'green' : 'yellow',
        (st) => openKey(st, 'zama'),
      ),
      row('Stay unlocked for', unlockChoiceText(p.unlockMinutes), '', (st) => {
        const next = nextChoice<number>(UNLOCK_MINUTES_CHOICES, p.unlockMinutes);
        return savePrefs(
          st,
          { unlockMinutes: next },
          `Stay unlocked for: ${unlockChoiceText(next)}. The key stays in memory only.`,
        );
      }),
      row('Send countdown', countdownChoiceText(p.countdownSeconds), '', (st) => {
        const next = nextChoice<number>(COUNTDOWN_CHOICES, p.countdownSeconds);
        return savePrefs(
          st,
          { countdownSeconds: next },
          `Send countdown: ${countdownChoiceText(next)}. Mainnet always counts down at least ${MAINNET_MIN_COUNTDOWN} s.`,
        );
      }),
      SEP,
      backItem(),
    ];
    return {
      body: [],
      items,
      hint: '↑↓ move · enter change · esc back',
      help: [['enter', 'Change the setting; the last two cycle through their choices']],
    };
  },
};

function openKey(s: AppState, which: 'etherscan' | 'zama') {
  delete s.inputs.apiKey;
  return open(s, 'settings-key', { which });
}

export const settingsNetworkScreen: ScreenDef = {
  crumb: ['Settings', 'Network'],
  view: (s) => ({
    body: [dimLine('  Balances, tokens and history are kept per network.')],
    items: [
      {
        label: 'Sepolia testnet',
        value: s.network === 'sepolia' ? 'in use' : 'free test funds',
        valueStyle: 'green',
        act: (st) => setNetwork(st, 'sepolia', 'settings'),
      },
      {
        label: 'Ethereum Mainnet',
        value: s.network === 'mainnet' ? 'in use' : 'real funds · needs a Zama API key',
        valueStyle: 'yellow',
        act: (st) => setNetwork(st, 'mainnet', 'settings'),
      },
      backItem(),
    ],
    hint: '↑↓ move · enter switch · esc back',
  }),
};

export const settingsRpcScreen: ScreenDef = {
  crumb: ['Settings', 'RPC endpoint'],
  view: (s) => {
    const current = s.data.customRpc
      ? line('  Custom   ', seg(displayRpcUrl(s.data.customRpc), 'bold'))
      : line(
          '  Default  ',
          seg(DEFAULT_RPC_URLS[s.network], 'bold'),
          seg('  (with fallbacks)', 'dim'),
        );
    const items: Item[] = [
      { label: 'Check the endpoint', act: checkRpc },
      {
        label: 'Set a custom URL',
        act: (st) => {
          delete st.inputs.rpcUrl;
          return open(st, 'settings-rpc-url');
        },
      },
    ];
    if (s.data.customRpc) items.push({ label: 'Use the default again', act: resetRpc });
    items.push(backItem());
    return {
      body: [line(`  RPC endpoint for ${s.network}:`), BLANK, current],
      items,
      hint: '↑↓ move · enter select · esc back',
    };
  },
};

const RPC_SPEC: InputSpec = { field: 'rpcUrl', placeholder: 'https://…', maxLength: 300 };

export const settingsRpcUrlScreen: ScreenDef = {
  crumb: ['Settings', 'RPC endpoint'],
  view: (s) => ({
    body: [
      line(`  Paste an https:// RPC URL for ${s.network}:`),
      BLANK,
      inputLine(s, RPC_SPEC),
      BLANK,
      dimLine('  It is checked to serve the right chain before it is saved.'),
      dimLine('  URLs often contain an API key: it is stored in the owner-only .env file.'),
    ],
    input: RPC_SPEC,
    items: [{ label: 'Check and save', act: saveRpcUrl }, backItem()],
    hint: 'paste · enter save · esc back',
  }),
};

const KEY_SPEC: InputSpec = {
  field: 'apiKey',
  secret: true,
  placeholder: 'paste the key',
  maxLength: 200,
};

export const settingsKeyScreen: ScreenDef = {
  crumb: ['Settings', 'API key'],
  view: (s) => {
    const which = top(s).params.which === 'zama' ? 'zama' : 'etherscan';
    const isSet = which === 'zama' ? s.data.keys.zama : s.data.keys.etherscan;
    const items: Item[] = [{ label: 'Save key', act: (st) => saveApiKey(st, which) }];
    if (isSet) items.push({ label: 'Remove key', act: (st) => removeApiKey(st, which) });
    items.push(backItem());
    return {
      body: [
        line(
          '  ',
          seg(which === 'zama' ? 'Zama mainnet API key' : 'Etherscan API key', 'bold'),
          seg(isSet ? '   currently set' : '   not set', 'dim'),
        ),
        dimLine(
          which === 'zama'
            ? '  Needed for Mainnet encrypt and decrypt through the Zama relayer.'
            : '  Makes History fast. Without it, history uses a slower RPC scan.',
        ),
        BLANK,
        inputLine(s, KEY_SPEC),
        BLANK,
        dimLine(`  Hidden as you type. Stored in ${s.data.dataDir}/.env with owner-only access.`),
      ],
      input: KEY_SPEC,
      items,
      hint: 'paste · enter save · esc back',
    };
  },
};

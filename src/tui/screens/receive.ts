/**
 * Receive: the wallet address, a copy action and faucet links on Sepolia.
 * A terminal QR code is planned for Phase 4.
 */

import { effect } from '../effects.js';
import type { Item, ScreenDef } from '../screen.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { backItem, BLANK } from './common.js';

/** Public Sepolia faucets (they change over time; the list is informational). */
export const SEPOLIA_FAUCETS = [
  'https://cloud.google.com/application/web3/faucet/ethereum/sepolia',
  'https://www.alchemy.com/faucets/ethereum-sepolia',
];

/** Item that offers the address to the terminal clipboard (OSC 52). */
export function copyAddressItem(): Item {
  return {
    label: 'Copy address',
    act: (s) => {
      const address = s.wallet?.address;
      if (!address) return;
      return [
        effect('clipboard', async (deps) => {
          const okCopy = deps.copyToClipboard(address);
          return (st) => {
            st.flash = okCopy
              ? [
                  line('  ', seg('✔ Sent to your terminal clipboard.', 'green')),
                  dimLine(
                    '    Most modern terminals support this. If pasting gives nothing, select the address above.',
                  ),
                ]
              : [
                  dimLine(
                    '  This terminal cannot receive clipboard data. Select the address above to copy it.',
                  ),
                ];
          };
        }),
      ];
    },
  };
}

export const receiveScreen: ScreenDef = {
  crumb: ['Receive'],
  view: (s) => {
    const net = s.network === 'mainnet' ? 'Ethereum Mainnet' : 'Sepolia';
    const body: Line[] = [
      line('  Send tokens or ETH on ', seg(net, 'cyan'), ' to:'),
      BLANK,
      line('  ', seg(s.wallet?.address ?? '', 'bold')),
      BLANK,
      dimLine('  A QR code for this address is coming in a later update.'),
    ];
    const items: Item[] = [copyAddressItem()];
    if (s.network === 'sepolia') {
      items.push({
        label: 'Get test ETH',
        act: (st) => {
          st.flash = [
            dimLine('  Free Sepolia ETH faucets (open one in your browser, paste your address):'),
            ...SEPOLIA_FAUCETS.map((u) => line(seg(`    ${u}`, 'cyan'))),
            dimLine('  The status bar updates when ETH arrives.'),
          ];
        },
      });
    }
    items.push(backItem());
    return {
      body,
      items,
      hint: 'enter select · esc back',
      help: [['enter', 'Copy the address or show faucet links']],
    };
  },
};

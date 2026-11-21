/**
 * The send wizard screens: Token → Recipient (contact, paste, look-alike stop) → Amount →
 * Review → Sign, the mainnet retype guard, the countdown and the error screen.
 * The logic lives in flows/send.ts; these modules only draw and wire items to it.
 */

import { formatBalance, formatExactAmount, hasAmbiguousComma } from '../../core/send/amount.js';
import { formatTokenAmount } from '../../utils/formatting.js';
import { shortAddress, splitForComparison } from '../../core/send/recipient.js';
import {
  afterSignUnlock,
  balanceLine,
  chooseContact,
  chooseToken,
  confirmSend,
  draftToken,
  isPrepared,
  knownBalance,
  parseDraftAmount,
  recipientLabel,
  stopCountdown,
  submitAmount,
  submitPastedAddress,
  submitRetype,
  useContactInstead,
  usePastedLookalike,
  countdownSeconds,
} from '../flows/send.js';
import { unlock } from '../flows/wallet.js';
import { formatEth, spinner } from '../format.js';
import { open, openFromRoot } from '../nav.js';
import type { InputSpec, Item, MenuEntry, ScreenDef } from '../screen.js';
import { back, goHome, isUnlocked, top, type AppState } from '../state.js';
import { dimLine, line, pad, padLeft, seg, type Line } from '../text.js';
import { unlockMinutesText } from './balances.js';
import { backItem, BLANK, inputLine, SEND_STEPS, SEP, stepper } from './common.js';

const cancelItem: Item = {
  label: 'Cancel',
  act: (s) => goHome(s, [dimLine('  Send cancelled. Nothing was signed.')]),
};

function sticky(s: AppState) {
  return s.data.prefs.networks[s.network];
}

export const sendTokenScreen: ScreenDef = {
  crumb: ['Send', 'Token'],
  view: (s) => {
    const last = sticky(s).lastToken?.toLowerCase();
    const items: MenuEntry[] = s.data.tokens.map((t) => {
      const b = knownBalance(s, t.address);
      const bal = b ? formatBalance(b.value, t.decimals) : 'locked';
      return {
        label: `${pad(t.symbol, 8)} ${padLeft(bal, 16)}`,
        value: t.address.toLowerCase() === last ? 'last used' : '',
        valueStyle: 'dim',
        act: (st) => chooseToken(st, t.address),
      };
    });
    items.push(SEP, cancelItem);
    return {
      body: [stepper(0, SEND_STEPS)],
      items,
      hint: '↑↓ move · enter next · esc back',
      help: [['enter', 'Send this token']],
    };
  },
};

export const sendToScreen: ScreenDef = {
  crumb: ['Send', 'Recipient'],
  view: (s) => {
    const last = sticky(s).lastRecipient?.toLowerCase();
    const items: MenuEntry[] = s.data.contacts.map((c) => ({
      label: `${pad(c.name, 14)} ${shortAddress(c.address)}`,
      value: c.address.toLowerCase() === last ? 'last used' : '',
      valueStyle: 'dim',
      act: (st) => chooseContact(st, c),
    }));
    if (items.length) items.push(SEP);
    items.push({
      label: 'Paste an address',
      key: 'p',
      act: (st) => open(st, 'send-paste'),
    });
    items.push(SEP, backItem());
    const t = draftToken(s);
    return {
      body: [stepper(1, SEND_STEPS), BLANK, line('  Send ', seg(t?.symbol ?? '', 'bold'), ' to:')],
      items,
      hint: '↑↓ move · enter next · p paste · esc back (keeps your token)',
      help: [
        ['enter', 'Send to this contact'],
        ['p', 'Paste an address instead'],
      ],
    };
  },
};

const PASTE_SPEC: InputSpec = {
  field: 'paste',
  placeholder: '0x… recipient address',
  accept: /^[0-9a-zA-Z]$/,
  maxLength: 42,
};

export const sendPasteScreen: ScreenDef = {
  crumb: ['Send', 'Recipient'],
  view: (s) => ({
    body: [
      stepper(1, SEND_STEPS),
      BLANK,
      line('  Paste the recipient address:'),
      BLANK,
      inputLine(s, PASTE_SPEC),
      BLANK,
      dimLine('  Mixed-case addresses are checked against their checksum.'),
    ],
    input: PASTE_SPEC,
    items: [{ label: 'Continue', act: submitPastedAddress }, backItem()],
    hint: 'paste · enter continue · esc back',
  }),
};

/** Address with the compared start and end in bold and the rest in `midStyle`. */
function comparedAddress(address: string, midStyle: string): Line {
  const [head, mid, tail] = splitForComparison(address);
  return [seg(head, 'bold'), seg(mid, midStyle), seg(tail, 'bold')];
}

export const sendCheckScreen: ScreenDef = {
  crumb: ['Send', 'Recipient'],
  view: (s) => {
    const { address = '', contact = '' } = top(s).params;
    const saved = s.data.contacts.find((c) => c.name === contact);
    const body: Line[] = [
      stepper(1, SEND_STEPS),
      BLANK,
      line(
        '  ',
        seg(
          `✗ Careful: this looks like your contact ${contact}, but it is a different address.`,
          'red bold',
        ),
      ),
      BLANK,
    ];
    if (saved) {
      body.push([
        seg(`  ${pad(`${contact} (saved)`, 16)}`),
        ...comparedAddress(saved.address, 'dim'),
      ]);
    }
    body.push([seg(`  ${pad('pasted', 16)}`), ...comparedAddress(address, 'red')]);
    body.push(
      BLANK,
      dimLine('  Scammers send tiny transfers from look-alike addresses so you copy'),
      dimLine('  the wrong one from your history. The start and end match on purpose.'),
    );
    return {
      body,
      items: [
        { label: `Send to ${contact} instead`, act: (st) => useContactInstead(st, contact) },
        {
          label: 'I checked it, use the pasted address',
          act: (st) => usePastedLookalike(st, address),
        },
        backItem(),
      ],
      hint: 'enter select · esc back',
    };
  },
};

const AMOUNT_SPEC: InputSpec = {
  field: 'amount',
  placeholder: 'try 25, 1k, half or max',
  accept: /^[0-9a-zA-Z.,]$/,
  maxLength: 40,
};

export const sendAmountScreen: ScreenDef = {
  crumb: ['Send', 'Amount'],
  view: (s) => {
    const t = draftToken(s);
    const to = s.send.to;
    const text = s.inputs.amount ?? '';
    let suffix: Line | undefined;
    if (t && text) {
      const r = parseDraftAmount(s);
      if (r?.ok) {
        suffix = [seg(`   = ${formatExactAmount(r.value, t.decimals)} ${t.symbol}`, 'cyan')];
        if (r.meaning) suffix.push(seg(`  (${r.meaning})`, 'dim'));
      } else if (r && !s.fieldError) {
        suffix = [seg(`   ${r.error}`, 'yellow')];
      }
    }
    const body: Line[] = [
      stepper(2, SEND_STEPS),
      BLANK,
      line(
        '  Amount of ',
        seg(t?.symbol ?? '', 'bold'),
        ' to send to ',
        seg(to ? recipientLabel(to) : '', 'bold'),
      ),
      BLANK,
      inputLine(s, AMOUNT_SPEC, suffix),
      BLANK,
      dimLine(`  ${t ? balanceLine(s, t) : ''}`),
    ];
    const setAmount = (value: string) => (st: AppState) => {
      st.inputs.amount = value;
      st.fieldError = null;
    };
    return {
      body,
      input: AMOUNT_SPEC,
      items: [
        { label: 'Continue', act: submitAmount },
        { label: 'Half', act: setAmount('half') },
        { label: 'Max', act: setAmount('max') },
        backItem(),
      ],
      hint: 'type an amount · enter continue · esc back (keeps recipient)',
      help: [
        ['25  1,250.50', 'Plain amounts, with or without thousands commas'],
        ['1k  2.5k', 'Thousands'],
        ['half  max', 'Of your decrypted balance'],
      ],
    };
  },
};

/** The three pre-send checks, shown on Review once the simulation ran. */
function checksLine(s: AppState): Line {
  if (!isUnlocked(s))
    return dimLine('  Checks run after you unlock: simulation, balance, ERC-7984.');
  if (s.send.checking || !isPrepared(s)) {
    return line('  ', seg(`${spinner(s.now)} Simulating the transfer…`, 'cyan'));
  }
  return line(
    '  ',
    seg('✔ Simulation passed', 'green'),
    '   ',
    seg('✔ Balance covers amount', 'green'),
    '   ',
    seg('✔ ERC-7984', 'green'),
  );
}

export const sendReviewScreen: ScreenDef = {
  crumb: ['Send', 'Review'],
  view: (s) => {
    const t = draftToken(s);
    const to = s.send.to;
    const w = s.wallet;
    if (!t || !to || s.send.value === undefined || !w) {
      return {
        body: [dimLine('  This send is incomplete. Go back and fill in the missing step.')],
        items: [backItem(), cancelItem],
        hint: 'esc back',
      };
    }
    const prepared = isPrepared(s) ? s.send.prepared : undefined;
    const fee = prepared
      ? line(
          `  Fee       ≈ ${formatEth(prepared.feeWei)} ETH`,
          seg(`   you have ${s.eth ? formatEth(s.eth.wei) : '…'} ETH`, 'dim'),
        )
      : line('  Fee       ', seg('estimated after the simulation', 'dim'));
    const body: Line[] = [
      stepper(3, SEND_STEPS),
      BLANK,
      line('  From      ', seg(pad(w.name, 12), 'bold'), ' ', seg(w.address, 'dim')),
      line(
        '  To        ',
        seg(pad(to.name ?? 'address', 12), 'bold'),
        ' ',
        seg(to.address, to.lookalike ? 'red' : 'dim'),
      ),
      line(
        '  Amount    ',
        seg(`${formatExactAmount(s.send.value, t.decimals)} ${t.symbol}`, 'yellow bold'),
        seg('   encrypted on-chain', 'dim'),
      ),
      // The same amount ungrouped and in base units, so "1,500" cannot be misread.
      dimLine(
        `            = ${formatTokenAmount(s.send.value, t.decimals, t.decimals)} ${t.symbol} · ${s.send.value} base units`,
      ),
      line(
        '  Network   ',
        s.network === 'mainnet'
          ? seg(' MAINNET · real funds ', 'mainnet')
          : seg('Sepolia testnet', 'cyan'),
      ),
      fee,
      BLANK,
      checksLine(s),
    ];
    if (hasAmbiguousComma(s.inputs.amount ?? '')) {
      body.push(
        BLANK,
        line(
          seg(
            `  ! You typed "${s.inputs.amount?.trim()}": commas group thousands here. For a decimal amount, use a point (1.5).`,
            'yellow',
          ),
        ),
      );
    }
    if (to.lookalike) {
      body.push(
        BLANK,
        line(
          seg(
            '  ✗ You confirmed a look-alike address. Check every character with the recipient.',
            'red',
          ),
        ),
      );
    } else if (to.isNew) {
      body.push(
        BLANK,
        line(seg('  ! First time sending to this address. Check it with the recipient.', 'yellow')),
      );
    }
    if (s.network === 'mainnet') {
      body.push(
        BLANK,
        line(seg("  On Mainnet you'll retype the amount before it is sent.", 'yellow')),
      );
    }
    const secs = countdownSeconds(s);
    if (secs > 0)
      body.push(dimLine(`  After you confirm, a ${secs} s countdown lets you stop it with Esc.`));
    return {
      body,
      items: [
        { label: isUnlocked(s) ? 'Confirm and send' : 'Confirm and sign', act: confirmSend },
        { label: 'Change amount', act: (st) => back(st) },
        cancelItem,
      ],
      hint: '↑↓ move · enter select · esc back to amount',
      help: [['enter', 'Confirm, change the amount or cancel']],
    };
  },
};

const SIGN_SPEC: InputSpec = { field: 'unlock', secret: true, placeholder: 'your wallet password' };

export const sendSignScreen: ScreenDef = {
  crumb: ['Send', 'Sign'],
  view: (s) => ({
    body: [
      stepper(4, SEND_STEPS),
      BLANK,
      line('  Password for ', seg(s.wallet?.name ?? '', 'bold')),
      BLANK,
      inputLine(s, SIGN_SPEC),
      BLANK,
      dimLine(
        s.data.prefs.unlockMinutes === 0
          ? '  Unlocks for this send only, then locks again (Settings › Stay unlocked for).'
          : `  ${unlockMinutesText(s)} Your next sends skip this step while unlocked.`,
      ),
    ],
    input: SIGN_SPEC,
    items: [
      { label: 'Unlock and check', act: (st) => unlock(st, 'review', afterSignUnlock) },
      backItem(),
    ],
    hint: 'type password · enter unlock · esc back',
  }),
};

const RETYPE_SPEC: InputSpec = {
  field: 'retype',
  placeholder: 'the exact amount',
  accept: /^[0-9a-zA-Z.,]$/,
  maxLength: 40,
};

export const sendRetypeScreen: ScreenDef = {
  crumb: ['Send', 'Confirm'],
  view: (s) => {
    const t = draftToken(s);
    return {
      body: [
        stepper(4, SEND_STEPS),
        BLANK,
        line('  ', seg(' MAINNET · real funds ', 'mainnet')),
        BLANK,
        line(
          '  Type the amount again to confirm: ',
          seg(
            t && s.send.value !== undefined
              ? `${formatExactAmount(s.send.value, t.decimals)} ${t.symbol}`
              : '',
            'bold',
          ),
        ),
        BLANK,
        inputLine(s, RETYPE_SPEC),
      ],
      input: RETYPE_SPEC,
      items: [{ label: 'Confirm', act: submitRetype }, backItem()],
      hint: 'type the amount · enter confirm · esc back',
    };
  },
};

export const sendCountScreen: ScreenDef = {
  crumb: ['Send', 'Sending'],
  view: (s) => {
    const t = draftToken(s);
    const to = s.send.to;
    const cd = s.countdown;
    const left = cd ? Math.max(0, Math.ceil((cd.endsAt - s.now) / 1000)) : 0;
    const total = cd?.total ?? 0;
    const amount =
      t && s.send.value !== undefined
        ? `${formatBalance(s.send.value, t.decimals)} ${t.symbol}`
        : '';
    return {
      body: [
        stepper(4, SEND_STEPS),
        BLANK,
        BLANK,
        line(
          '      ',
          seg(`Sending ${amount} to ${to ? recipientLabel(to) : ''} in ${left}…`, 'big'),
        ),
        BLANK,
        line('      ', seg('■'.repeat(left) + '□'.repeat(Math.max(0, total - left)), 'yellow')),
        BLANK,
        dimLine('      Esc stops it. Nothing has been broadcast yet.'),
      ],
      items: [],
      bare: true,
      hint: 'esc stop · ctrl+c stop and go Home',
      onKey: (st, key) => {
        if (key === 'escape') {
          stopCountdown(st, false);
          return { handled: true };
        }
        if (key === 'ctrl-c') {
          stopCountdown(st, true);
          return { handled: true };
        }
        return { handled: true }; // every other key is ignored while counting down
      },
    };
  },
};

export const sendErrorScreen: ScreenDef = {
  crumb: ['Send', 'Problem'],
  view: (s) => {
    const v = s.errorView;
    if (!v) {
      return { body: [dimLine('  Nothing to show.')], items: [backItem()], hint: 'esc back' };
    }
    const e = v.error;
    const body: Line[] = [];
    const from = top(s).params.from;
    if (from !== 'home' && from !== 'action') body.push(stepper(3, SEND_STEPS), BLANK);
    body.push(
      v.afterBroadcast
        ? line('  ', seg('! The transaction was handed to the network.', 'yellow bold'))
        : line(
            '  ',
            seg(
              `✗ ${from === 'action' ? 'Stopped' : 'Send stopped'}. Nothing was signed or sent.`,
              'red bold',
            ),
          ),
      BLANK,
      line(`  ${e.title}`),
      BLANK,
    );
    if (e.cause) body.push(line('  ', seg('Likely cause', 'bold')), line(`  ${e.cause}`), BLANK);
    if (e.hint) body.push(line('  ', seg('What to try', 'bold')), line(`  ${e.hint}`));
    if (e.txHash) body.push(BLANK, line('  Transaction  ', seg(e.txHash, 'bold')));
    // On its own row so it can be copied in one piece.
    if (v.explorerUrl) body.push(line('  Explorer'), line('  ', seg(v.explorerUrl, 'cyan')));
    if (e.replacementHash) body.push(line('  Replaced by  ', seg(e.replacementHash, 'bold')));
    if (v.afterBroadcast) {
      body.push(
        BLANK,
        line(
          seg(
            '  Do not send again until the explorer shows what happened: it could pay twice.',
            'yellow',
          ),
        ),
      );
    }
    if (v.showRaw) {
      body.push(BLANK, line('  ', seg('Technical details', 'bold')));
      const raw = e.raw || 'No technical details were recorded.';
      for (const chunk of raw.match(/.{1,96}/g) ?? []) body.push(dimLine(`  ${chunk}`));
    }
    const toggle: Item = {
      label: v.showRaw ? 'Hide technical details' : 'Show technical details',
      act: (st) => {
        if (st.errorView) st.errorView = { ...st.errorView, showRaw: !st.errorView.showRaw };
      },
    };
    const items: Item[] = v.afterBroadcast
      ? [
          toggle,
          {
            label: 'Dismiss',
            act: (st) => {
              st.lastSendError = null;
              goHome(st, [dimLine('  Check the explorer link before sending again.')]);
            },
          },
          backItem(),
        ]
      : [
          { label: 'Run Doctor', act: (st) => openFromRoot(st, 'doctor') },
          toggle,
          ...(from === 'home' ? [] : [backItem('Back to review')]),
          cancelItem,
        ];
    return {
      body,
      items,
      hint: 'enter select · esc back',
    };
  },
};

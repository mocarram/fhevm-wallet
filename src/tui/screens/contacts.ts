/**
 * Address book: list, add (name, then checksum-checked address), remove. The same name
 * step saves the "new address" offered on Home after a send.
 */

import { shortAddress } from '../../core/send/recipient.js';
import { removeContact, submitContactAddress, submitContactName } from '../flows/manage.js';
import { open } from '../nav.js';
import type { Item, ScreenDef } from '../screen.js';
import { back, top } from '../state.js';
import { dimLine, line, pad, seg } from '../text.js';
import { backItem, BLANK, inputLine, pasteAddressInto, SEP } from './common.js';
import { matchesFilter } from '../components/list.js';

const CONTACTS_FILTER = 'filter.contacts';

export const contactsScreen: ScreenDef = {
  crumb: ['Address book'],
  view: (s) => ({
    filter: CONTACTS_FILTER,
    ...(() => {
      const q = s.inputs[CONTACTS_FILTER];
      const shown = s.data.contacts.filter((c) => matchesFilter(`${c.name} ${c.address}`, q));
      if (shown.length) {
        return {
          body: [],
          list: shown.map((c) =>
            line('  ', seg(pad(c.name, 14), 'bold'), ' ', seg(c.address, 'dim')),
          ),
        };
      }
      return { body: [dimLine(q ? '  No contact matches the filter.' : '  No contacts yet.')] };
    })(),
    items: [
      {
        label: 'Add contact',
        act: (st) => {
          delete st.inputs.contactName;
          delete st.inputs.contactAddress;
          return open(st, 'contact-name');
        },
      },
      { label: 'Remove contact', act: (st) => open(st, 'contact-remove') },
      backItem(),
    ],
    hint: '↑↓ move · enter select · / filter · esc back',
    help: [
      ['/', 'Filter the contacts by name or address'],
      ['paste', 'A pasted address starts Add contact with it filled in'],
    ],
    // A pasted address starts "Add contact" with the address step filled in.
    onPaste: (st, text) => {
      delete st.inputs.contactName;
      return pasteAddressInto('contactAddress', 'contact-name')(st, text);
    },
  }),
};

const NAME_SPEC = {
  field: 'contactName',
  placeholder: 'e.g. bob',
  accept: /^[a-zA-Z0-9 ]$/,
  maxLength: 32,
};
const ADDR_SPEC = {
  field: 'contactAddress',
  placeholder: '0x…',
  accept: /^[0-9a-zA-Z]$/,
  maxLength: 42,
};

export const contactNameScreen: ScreenDef = {
  crumb: ['Address book', 'Name'],
  view: (s) => {
    const prefilled = top(s).params.address;
    return {
      body: [
        prefilled
          ? line('  Name for ', seg(shortAddress(prefilled), 'bold'), ':')
          : line('  Name for the new contact:'),
        BLANK,
        inputLine(s, NAME_SPEC),
      ],
      input: NAME_SPEC,
      items: [
        { label: prefilled ? 'Save contact' : 'Continue', act: submitContactName },
        backItem(),
      ],
      hint: 'type a name · enter continue · esc back',
    };
  },
};

export const contactAddressScreen: ScreenDef = {
  crumb: ['Address book', 'Address'],
  view: (s) => ({
    body: [
      line('  Address of ', seg(s.inputs.contactName ?? '', 'bold'), ':'),
      BLANK,
      inputLine(s, ADDR_SPEC),
      BLANK,
      dimLine('  Mixed-case addresses are checked against their checksum.'),
    ],
    input: ADDR_SPEC,
    items: [{ label: 'Save contact', act: submitContactAddress }, backItem()],
    hint: 'paste address · enter save · esc back',
  }),
};

const REMOVE_FILTER = 'filter.contactRemove';

export const contactRemoveScreen: ScreenDef = {
  crumb: ['Address book', 'Remove'],
  view: (s) => {
    const q = s.inputs[REMOVE_FILTER];
    const shown = s.data.contacts.filter((c) => matchesFilter(`${c.name} ${c.address}`, q));
    return {
      body: [dimLine('  Pick a contact to remove. You confirm on the next step.')],
      items: [
        ...shown.map<Item>((c) => ({
          label: `${pad(c.name, 14)} ${shortAddress(c.address)}`,
          act: (st) => open(st, 'contact-remove-confirm', { name: c.name }),
        })),
        SEP,
        backItem(),
      ],
      filter: REMOVE_FILTER,
      hint: '↑↓ move · enter pick · / filter · esc back',
    };
  },
};

/** "Remove bob?": a removal is never one key press (a double tap used to remove one). */
export const contactRemoveConfirmScreen: ScreenDef = {
  crumb: ['Address book', 'Remove'],
  view: (s) => {
    const name = top(s).params.name ?? '';
    const c = s.data.contacts.find((x) => x.name === name);
    if (!c)
      return { body: [dimLine('  That contact is gone.')], items: [backItem()], hint: 'esc back' };
    return {
      body: [
        line('  Remove ', seg(c.name, 'bold'), ' from your address book?'),
        line('  ', seg(c.address, 'dim')),
        BLANK,
        dimLine('  Pasted look-alikes of this address are no longer caught once it is removed.'),
      ],
      items: [
        { label: 'Keep it', act: (st) => back(st) },
        { label: `Remove ${c.name}`, valueStyle: 'red', act: (st) => removeContact(st, c.name) },
      ],
      hint: 'enter select · esc back',
    };
  },
};

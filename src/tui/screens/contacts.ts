/**
 * Address book: list, add (name, then checksum-checked address), remove. The same name
 * step saves the "new address" offered on Home after a send.
 */

import { shortAddress } from '../../core/send/recipient.js';
import { removeContact, submitContactAddress, submitContactName } from '../flows/manage.js';
import { open } from '../nav.js';
import type { Item, ScreenDef } from '../screen.js';
import { top } from '../state.js';
import { dimLine, line, pad, seg } from '../text.js';
import { backItem, BLANK, inputLine, SEP } from './common.js';
import { matchesFilter } from '../components/list.js';

const CONTACTS_FILTER = 'filter.contacts';

export const contactsScreen: ScreenDef = {
  crumb: ['Address book'],
  view: (s) => ({
    filter: CONTACTS_FILTER,
    body: (() => {
      const q = s.inputs[CONTACTS_FILTER];
      const shown = s.data.contacts.filter((c) => matchesFilter(`${c.name} ${c.address}`, q));
      if (shown.length) {
        return shown.map((c) =>
          line('  ', seg(pad(c.name, 14), 'bold'), ' ', seg(c.address, 'dim')),
        );
      }
      return [dimLine(q ? '  No contact matches the filter.' : '  No contacts yet.')];
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

export const contactRemoveScreen: ScreenDef = {
  crumb: ['Address book', 'Remove'],
  view: (s) => ({
    body: [dimLine('  Pick a contact to remove.')],
    items: [
      ...s.data.contacts.map<Item>((c) => ({
        label: `${pad(c.name, 14)} ${shortAddress(c.address)}`,
        act: (st) => removeContact(st, c.name),
      })),
      SEP,
      backItem(),
    ],
    hint: '↑↓ move · enter remove · esc back',
  }),
};

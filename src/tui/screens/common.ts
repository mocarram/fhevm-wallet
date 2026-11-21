/**
 * Building blocks shared by screens: back items, text field lines, the stepper.
 */

import { back, type AppState } from '../state.js';
import type { Effect } from '../effects.js';
import { open } from '../nav.js';
import { seg, line, type Line } from '../text.js';
import type { InputSpec, Item, Separator } from '../screen.js';

/** "Back" menu item (same as Esc). */
export function backItem(label = 'Back'): Item {
  return { label, act: (s) => back(s) };
}

const PASTED_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * `onPaste` for a menu screen whose address step is a text field: a pasted address
 * opens that step with the field filled in (Continue still runs every check on it).
 * Anything else falls back to "Pasted text ignored".
 */
export function pasteAddressInto(
  field: string,
  screen: string,
  params: Record<string, string> = {},
): (s: AppState, text: string) => { handled: boolean; effects?: Effect[] } {
  return (s, text) => {
    if (!PASTED_ADDRESS.test(text)) return { handled: false };
    const effects = open(s, screen, params);
    s.inputs[field] = text;
    return { handled: true, effects };
  };
}

/** A divider. */
export const SEP: Separator = { sep: true };

/**
 * The line showing a text field: `› text█`, masked for secrets, with a placeholder when
 * empty and an optional suffix (e.g. "= 25.00 cUSDC").
 */
export function inputLine(s: AppState, spec: InputSpec, suffix?: Line): Line {
  const value = s.inputs[spec.field] ?? '';
  const shown = spec.secret ? '*'.repeat(Array.from(value).length) : value;
  const parts: Line = [seg('  '), seg('› ', 'cyan')];
  if (spec.label) parts.unshift(seg(`  ${spec.label}`));
  parts.push(seg(shown, 'bold'), seg(' ', 'cursor'));
  if (!value && spec.placeholder) parts.push(seg(`  ${spec.placeholder}`, 'dim'));
  if (suffix) parts.push(...suffix);
  return parts;
}

/** Wizard progress, e.g. `✔ Token ─ ● Recipient ─ ○ Amount …`. */
export function stepper(active: number, names: string[]): Line {
  const out: Line = [seg('  ')];
  names.forEach((name, i) => {
    if (i) out.push(seg(' ─ ', 'dim'));
    if (i < active) out.push(seg(`✔ ${name}`, 'green'));
    else if (i === active) out.push(seg(`● ${name}`, 'yellow bold'));
    else out.push(seg(`○ ${name}`, 'dim'));
  });
  return out;
}

/** Steps of the send wizard. */
export const SEND_STEPS = ['Token', 'Recipient', 'Amount', 'Review', 'Sign'];
/** Steps of first-run setup. */
export const SETUP_STEPS = ['Wallet', 'Network', 'Token', 'Gas'];

/** An empty line. */
export const BLANK: Line = line('');

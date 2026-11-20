/**
 * Building blocks shared by screens: back items, text field lines, the stepper.
 */

import { back, type AppState } from '../state.js';
import { seg, line, type Line } from '../text.js';
import type { InputSpec, Item, Separator } from '../screen.js';

/** "Back" menu item (same as Esc). */
export function backItem(label = 'Back'): Item {
  return { label, act: (s) => back(s) };
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

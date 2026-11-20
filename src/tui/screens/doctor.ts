/**
 * Doctor: quick checks of Node, RPC, relayer settings, gas, tokens and data folder.
 * The full `fhew doctor` command (with a per-token ERC-7984 check) is Phase 4.
 */

import { runDoctor } from '../flows/manage.js';
import { spinner } from '../format.js';
import { open } from '../nav.js';
import type { ScreenDef } from '../screen.js';
import type { DoctorRow } from '../state.js';
import { dimLine, line, seg, type Line } from '../text.js';
import { backItem } from './common.js';

const MARK: Record<DoctorRow['status'], [string, string]> = {
  ok: ['✔', 'green'],
  warn: ['!', 'yellow'],
  fail: ['✗', 'red'],
  info: ['·', 'dim'],
};

/** Lines for a list of doctor rows (also used by setup's gas step). */
export function doctorLines(rows: DoctorRow[]): Line[] {
  return rows.map((r) => {
    const [mark, style] = MARK[r.status];
    return line('  ', seg(mark, style), ` ${r.text}`, r.detail ? seg(` ${r.detail}`, 'dim') : '');
  });
}

export const doctorScreen: ScreenDef = {
  crumb: ['Doctor'],
  onEnter: runDoctor,
  view: (s) => {
    const body = s.doctor
      ? doctorLines(s.doctor)
      : [line('  ', seg(`${spinner(s.now)} Checking…`, 'cyan'))];
    if (s.backendKind === 'mock')
      body.push(line(''), dimLine('  Offline mock backend: network results are simulated.'));
    return {
      body,
      items: [
        { label: 'Run again', act: runDoctor },
        { label: 'Go to Tokens', act: (st) => open(st, 'tokens') },
        { label: 'Go to Settings', act: (st) => open(st, 'settings') },
        backItem(),
      ],
      hint: 'enter select · esc back',
    };
  },
};

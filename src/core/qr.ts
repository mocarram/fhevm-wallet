/**
 * Terminal QR codes for the Receive screen and `fhew receive`.
 *
 * The encoder is the one vendored inside `qrcode-terminal` (Apache-2.0, no
 * dependencies, pinned to 0.12.0); only its matrix is used. Drawing is done here, two
 * modules per character with half blocks, so the TUI can place the code in its own
 * layout. Light modules are drawn as filled blocks (the usual terminal foreground on a
 * dark background), with a quiet zone of two modules, like qrcode-terminal's own small
 * mode. Phone cameras read the inverted form on light-background terminals as well.
 */

import { createRequire } from 'module';
import { getAddress } from 'ethers';

interface QRCodeModel {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

const require = createRequire(import.meta.url);
// No types ship with the package; the shape above is all that is used.
const QRCode = require('qrcode-terminal/vendor/QRCode') as new (
  typeNumber: number,
  level: number,
) => QRCodeModel;
const LEVEL = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { M: number };

/** The QR module matrix for `text` (true = dark), error correction M. */
export function qrMatrix(text: string): boolean[][] {
  const qr = new QRCode(-1, LEVEL.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** Quiet zone around the code, in modules. */
const QUIET = 2;

/** The code as lines of half-block characters (see the module comment). */
export function qrLines(text: string): string[] {
  const m = qrMatrix(text);
  const n = m.length + QUIET * 2;
  const dark = (r: number, c: number) => {
    const rr = r - QUIET;
    const cc = c - QUIET;
    return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr][cc];
  };
  const out: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let row = '';
    for (let c = 0; c < n; c++) {
      const top = !dark(r, c);
      const bottom = r + 1 < n ? !dark(r + 1, c) : false;
      row += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    out.push(row);
  }
  return out;
}

/** EIP-681 payment URI for an address on a chain: `ethereum:<address>@<chainId>`. */
export function eip681(address: string, chainId: number): string {
  return `ethereum:${getAddress(address)}@${chainId}`;
}

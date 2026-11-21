import { describe, expect, it } from 'vitest';
import { eip681, qrLines, qrMatrix } from '../../src/core/qr.js';

const ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';

/** A 7x7 finder pattern at (r, c): dark ring, light ring, dark 3x3 core. */
function finderAt(m: boolean[][], r: number, c: number): boolean {
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const ring = i === 0 || i === 6 || j === 0 || j === 6;
      const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      if (m[r + i][c + j] !== (ring || core)) return false;
    }
  }
  return true;
}

describe('terminal QR', () => {
  it('builds a valid-looking matrix with the three finder patterns', () => {
    const m = qrMatrix(ADDR);
    const n = m.length;
    expect((n - 17) % 4).toBe(0); // 21, 25, 29, … modules: versions 1-40
    expect(finderAt(m, 0, 0)).toBe(true);
    expect(finderAt(m, 0, n - 7)).toBe(true);
    expect(finderAt(m, n - 7, 0)).toBe(true);
    // Different data, different code.
    expect(qrMatrix(eip681(ADDR, 11155111))).not.toEqual(m);
  });

  it('draws two rows per line with a quiet zone, using only block characters', () => {
    const m = qrMatrix(ADDR);
    const lines = qrLines(ADDR);
    expect(lines).toHaveLength(Math.ceil((m.length + 4) / 2));
    for (const l of lines) {
      expect(l).toHaveLength(m.length + 4);
      expect(l).toMatch(/^[█▀▄ ]+$/);
    }
    expect(lines[0]).toBe('█'.repeat(m.length + 4));
  });

  it('formats EIP-681 with a checksummed address', () => {
    expect(eip681(ADDR.toLowerCase(), 1)).toBe(`ethereum:${ADDR}@1`);
  });
});

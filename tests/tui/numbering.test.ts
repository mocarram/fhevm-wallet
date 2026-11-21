import { beforeEach, describe, expect, it } from 'vitest';
import { wipeTestDataDir } from '../helpers/dataDir.js';
import { Harness, STRANGER } from './harness.js';

beforeEach(() => wipeTestDataDir());

describe('stable numbers and cursor', () => {
  it('the cursor stays on its item when Home rows appear above it', async () => {
    const h = new Harness();
    await h.keys('{down}'); // on Send
    h.text();
    // A send confirms in the background: "save contact" and "repeat" rows arrive.
    h.s.offerSave = STRANGER;
    h.text();
    expect(h.text()).toMatch(/❯ 2 {2}Send/);
    await h.keys('{enter}');
    expect(h.screen).toBe('send-token');
  });

  it('History numbers do not move when there is nothing left to decrypt', async () => {
    const h = new Harness({ unlocked: true });
    await h.keys('h');
    const t = h.text();
    expect(t).toMatch(/1 {2}Decrypt amounts/);
    expect(t).toMatch(/4 {2}Disclose an amount/);
    expect(t).toMatch(/5 {2}Back/);
    await h.keys('1');
    expect(h.screen).toBe('history');
    expect(h.text()).toMatch(/already decrypted/);
  });
});

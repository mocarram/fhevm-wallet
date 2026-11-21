import { afterEach, describe, expect, it } from 'vitest';
import { prompts } from '../../../src/cli/utils/prompts.js';
import { describeError, NO_TERMINAL_MESSAGE } from '../../../src/cli/utils/userError.js';

const wasTTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = wasTTY;
});

describe('prompts without a terminal', () => {
  it('refuse at once with the "no interactive terminal" sentence', async () => {
    process.stdin.isTTY = false;
    for (const ask of [
      () => prompts.select({ message: 'x', choices: [{ name: 'a', value: 'a' }] }),
      () => prompts.input({ message: 'x' }),
      () => prompts.password({ message: 'x' }),
      () => prompts.confirm({ message: 'x' }),
    ]) {
      let caught: unknown;
      try {
        await ask();
      } catch (err) {
        caught = err;
      }
      expect(describeError(caught)).toBe(NO_TERMINAL_MESSAGE);
    }
  });
});

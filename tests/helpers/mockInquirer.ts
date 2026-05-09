import inquirer from 'inquirer';
import { vi } from 'vitest';

type Answers = Record<string, unknown>;

/**
 * Script inquirer to return sequential answers. Each call to inquirer.prompt()
 * pops one entry from the queue. Throws if the queue is empty so a test that
 * unintentionally hits a prompt fails loudly instead of hanging.
 */
export function mockInquirer(answers: Answers[]): ReturnType<typeof vi.spyOn> {
  const queue = [...answers];
  return vi.spyOn(inquirer, 'prompt').mockImplementation((async () => {
    if (queue.length === 0) {
      throw new Error('mockInquirer: ran out of scripted answers');
    }
    return queue.shift()!;
  }) as never);
}

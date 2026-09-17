import { describe, test, expect } from 'bun:test';
import { confirmKeyAction } from '../confirm-key.js';

/**
 * The confirmation is modal, so what it does with keys it was NOT given is as
 * important as what it does with y and n.
 */

const ESC = '\u001b';
const CTRL_C = '\u0003';
const press = (k: string) => confirmKeyAction(k, false);

describe('confirmKeyAction', () => {
  test('y and n answer, in either case', () => {
    expect(press('y')).toBe('submit');
    expect(press('Y')).toBe('submit');
    expect(press('n')).toBe('cancel');
    expect(press('N')).toBe('cancel');
  });

  test('escape cancels', () => {
    expect(press(ESC)).toBe('cancel');
  });

  test('Ctrl+C is never swallowed', () => {
    // A modal prompt that traps Ctrl+C is a prompt you cannot leave.
    expect(press(CTRL_C)).toBe('passthrough');
  });

  test('a key release is not a second answer', () => {
    // With the kitty protocol one press of y arrives as a press AND a release.
    // Acting on both would answer the same question twice.
    expect(confirmKeyAction('y', true)).toBe('passthrough');
    expect(confirmKeyAction(ESC + '[121;1:3u', true)).toBe('passthrough');
  });

  test('every other key is swallowed rather than typed', () => {
    // "yes" answers on y; without this the "es" lands in the input line and the
    // next Enter sends it to the agent as a query.
    for (const k of ['e', 's', '\r', ' ', 'a', ESC + '[A']) {
      expect(press(k)).toBe('ignore');
    }
  });
});

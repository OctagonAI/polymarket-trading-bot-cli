import { describe, test, expect } from 'bun:test';
import { parseKey, setKittyProtocolActive } from '@mariozechner/pi-tui';
import { confirmKeyAction } from '../confirm-key.js';

/**
 * These run the real terminal bytes through pi-tui's parser, because the bug
 * this module exists to prevent lived exactly in that gap: comparing raw bytes
 * works until the kitty keyboard protocol is negotiated, and then Esc and
 * Ctrl+C arrive as CSI sequences that match nothing.
 */

const ESC = '\u001b';
const act = (data: string, release = false) => confirmKeyAction(parseKey(data), release);

describe('confirmKeyAction — legacy encoding', () => {
  test('y and n answer, in either case', () => {
    expect(act('y')).toBe('submit');
    expect(act('Y')).toBe('submit');
    expect(act('n')).toBe('cancel');
    expect(act('N')).toBe('cancel');
  });

  test('bare escape cancels', () => {
    expect(act(ESC)).toBe('cancel');
  });

  test('the Ctrl+C byte is never swallowed', () => {
    expect(act('\u0003')).toBe('passthrough');
  });
});

describe('confirmKeyAction — kitty encoding', () => {
  // The terminals this CLI targets negotiate the protocol, so these are the
  // sequences that actually arrive in practice.
  setKittyProtocolActive(true);

  test('escape as CSI 27 u still cancels', () => {
    expect(act(ESC + '[27u')).toBe('cancel');
  });

  test('Ctrl+C as CSI 99;5u still passes through', () => {
    // Swallowing this leaves the user unable to quit while the prompt is up.
    expect(act(ESC + '[99;5u')).toBe('passthrough');
  });

  test('y and shift+y both submit', () => {
    expect(act(ESC + '[121u')).toBe('submit');
    expect(act(ESC + '[121;2u')).toBe('submit');
  });

  test('shift+n cancels', () => {
    expect(act(ESC + '[110;2u')).toBe('cancel');
  });

  test('a release of y is not a second answer', () => {
    // Press and release both parse to "y"; acting on both would submit twice.
    expect(act(ESC + '[121;1:3u', true)).toBe('passthrough');
  });
});

describe('confirmKeyAction — everything else', () => {
  test('other keys are swallowed rather than typed', () => {
    // "yes" answers on y; without this the "es" lands in the input line and the
    // next Enter sends it to the agent as a query.
    for (const k of ['e', 's', '\r', ' ', 'a', ESC + '[A']) {
      expect(act(k)).toBe('ignore');
    }
  });

  test('an unparseable key is ignored, not treated as an answer', () => {
    expect(confirmKeyAction(undefined, false)).toBe('ignore');
  });
});

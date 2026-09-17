/**
 * What a keypress means while an order is waiting to be confirmed.
 *
 * Takes a key id from pi-tui's `parseKey`, never raw bytes. That is the whole
 * point of this module: with the kitty keyboard protocol active — which it is,
 * in the terminals this CLI targets — Esc arrives as `CSI 27 u` and Ctrl+C as
 * `CSI 99;5u`, so comparing against `\u001b` and `\u0003` silently matches
 * nothing. `parseKey` normalises both encodings to "escape" and "ctrl+c".
 *
 * Three rules, each a bug avoided:
 *
 *  - **Ctrl+C passes through.** The prompt is modal, and a modal prompt that
 *    swallows Ctrl+C is a trap. Quitting belongs to the editor.
 *  - **Key releases pass through too.** One press of `y` produces a press event
 *    and a release event, and both parse to "y". Acting on both would answer
 *    the same question twice — for a submit, that means sending the order twice.
 *  - **Everything else is swallowed.** Otherwise a half-typed "yes" answers on
 *    `y` and leaves "es" in the input line, which the next Enter sends to the
 *    agent as a query.
 */
export type ConfirmKeyAction = 'submit' | 'cancel' | 'ignore' | 'passthrough';

export function confirmKeyAction(key: string | undefined, isRelease: boolean): ConfirmKeyAction {
  if (isRelease) return 'passthrough';
  if (key === 'ctrl+c') return 'passthrough';

  // Shift+y and a capital Y reach us differently depending on the encoding.
  const base = key?.replace(/^shift\+/, '').toLowerCase();
  if (base === 'y') return 'submit';
  if (base === 'n' || base === 'escape' || base === 'esc') return 'cancel';
  return 'ignore';
}

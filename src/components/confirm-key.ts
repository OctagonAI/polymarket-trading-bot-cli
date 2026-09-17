/**
 * What a single keypress means while an order is waiting to be confirmed.
 *
 * Pure so the rules can be tested without a terminal. Three of them are not
 * obvious, and each one is a bug avoided:
 *
 *  - **Ctrl+C passes through.** The prompt is modal, and a modal prompt that
 *    swallows Ctrl+C is a trap. Quitting belongs to the editor.
 *  - **Key releases pass through too.** With the kitty keyboard protocol
 *    active, one press of `y` produces a press event and a release event.
 *    Acting on both would answer the same question twice; the TUI already
 *    filters releases before any component sees them.
 *  - **Everything else is swallowed.** Otherwise a half-typed "yes" answers on
 *    `y` and leaves "es" in the input line, which the next Enter sends to the
 *    agent as a query.
 */
export type ConfirmKeyAction = 'submit' | 'cancel' | 'ignore' | 'passthrough';

const CTRL_C = '\u0003';
const ESC = '\u001b';

export function confirmKeyAction(data: string, isRelease: boolean): ConfirmKeyAction {
  if (data === CTRL_C) return 'passthrough';
  if (isRelease) return 'passthrough';
  if (data === 'y' || data === 'Y') return 'submit';
  if (data === 'n' || data === 'N' || data === ESC) return 'cancel';
  return 'ignore';
}

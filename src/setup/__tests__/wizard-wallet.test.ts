import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { SetupWizardController } from '../wizard.js';
import * as account from '../../wallet/account.js';
import { AccountResolutionError } from '../../wallet/account.js';

/**
 * Resolving a pasted key is a network round trip, and the two things that can
 * go wrong around it are invisible in normal use: an error that never renders,
 * and a result that lands on a run the user already abandoned.
 *
 * The controller keeps this state private and the path to `wallet_input` runs
 * through four earlier steps, so these drive it directly rather than replaying
 * the whole wizard to reach one method.
 */

const KEY = `0x${'a'.repeat(64)}`;
const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

interface Innards {
  wizardState: string;
  pendingWallet: unknown;
  handleWalletInput(value: string | null): Promise<void>;
}

/**
 * Records what the body looked like at each render, not just at the end.
 *
 * The flag that hides the error is cleared moments after the render it breaks,
 * so asserting on the final state would pass against the bug.
 */
function wizardAtWalletInput() {
  const renders: string[] = [];
  let w: SetupWizardController;
  w = new SetupWizardController(
    () => renders.push(w.getBodyLines().join('\n')),
    () => {},
  );
  w.start();
  const inner = w as unknown as Innards;
  inner.wizardState = 'wallet_input';
  return { w, inner, renders };
}

const resolved = {
  signer: '0xF2B909e5E2cBc2CFF2d07E02c9b1bAFd0B3A86a2',
  address: '0x18eD5C15CeD1bFdf88e701601C4a0BbD4F5142dE',
  walletType: 'deposit' as const,
  apiCreds: { key: 'k', secret: 's', passphrase: 'p' },
};

describe('wizard — a failed wallet resolution', () => {
  test('renders the error, not the "asking" line', async () => {
    // `getBodyLines` checks the resolving flag before `walletError`, so clearing
    // it after the render leaves the spinner text on screen with nothing to
    // follow it — the failure never reaches the user at all.
    spies.push(
      spyOn(account, 'resolveAccount').mockImplementation(async () => {
        throw new AccountResolutionError('Could not reach Polymarket.');
      }),
    );
    const { inner, renders } = wizardAtWalletInput();
    await inner.handleWalletInput(KEY);

    // The render triggered by the failure is the last one, and it is the one
    // the user actually sees.
    const shown = renders.at(-1) ?? '';
    expect(shown).toContain('Could not reach Polymarket.');
    expect(shown).not.toContain('Asking Polymarket');
  });

  test('stays on the step rather than skipping the wallet', async () => {
    spies.push(
      spyOn(account, 'resolveAccount').mockImplementation(async () => {
        throw new AccountResolutionError('nope');
      }),
    );
    const { inner } = wizardAtWalletInput();
    await inner.handleWalletInput(KEY);

    expect(inner.wizardState).toBe('wallet_input');
    expect(inner.pendingWallet).toBeNull();
  });
});

describe('wizard — a resolution that outlives its run', () => {
  /** A resolve that does not settle until the test says so. */
  function deferredResolve() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    spies.push(
      spyOn(account, 'resolveAccount').mockImplementation(async () => {
        await gate;
        return resolved;
      }),
    );
    return () => release();
  }

  test('a restart discards the wallet from the abandoned run', async () => {
    // The controller is a singleton reused for every run, and the request
    // cannot be aborted — the SDK takes no AbortSignal — so a late result would
    // otherwise jump the new run to `bankroll` carrying the old key's wallet,
    // which finishing the wizard would then write to disk.
    const release = deferredResolve();
    const { w, inner } = wizardAtWalletInput();
    const inFlight = inner.handleWalletInput(KEY);

    w.start();
    release();
    await inFlight;

    expect(inner.pendingWallet).toBeNull();
    expect(inner.wizardState).toBe('welcome');
  });

  test('a cancel discards it too', async () => {
    const release = deferredResolve();
    const { w, inner } = wizardAtWalletInput();
    const inFlight = inner.handleWalletInput(KEY);

    w.cancel();
    release();
    await inFlight;

    expect(inner.pendingWallet).toBeNull();
    expect(w.isActive).toBe(false);
  });

  test('an undisturbed run still applies its result', async () => {
    const release = deferredResolve();
    const { inner } = wizardAtWalletInput();
    const inFlight = inner.handleWalletInput(KEY);

    release();
    await inFlight;

    expect(inner.pendingWallet).toMatchObject({ address: resolved.address, type: 'deposit' });
    expect(inner.wizardState).toBe('bankroll');
  });
});

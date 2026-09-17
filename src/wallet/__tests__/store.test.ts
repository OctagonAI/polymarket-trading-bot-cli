import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseStoredWallet,
  readWalletFile,
  writeWalletFile,
  WALLET_FILE_MODE,
  WALLET_DIR_MODE,
  type StoredWallet,
} from '../store.js';

/**
 * Every case here passes an explicit path. `paths.ts` derives APP_DIR from
 * `homedir()` as a module const, so it cannot be spied — and adding an env
 * override purely for tests would widen production surface, which an existing
 * comment in `bankroll-setting.test.ts` argues against. Injecting the path at
 * the store boundary gets real coverage of the permission bits without that.
 */

const ADDRESS = '0x22cCF5a60aa6Ae13fe00554eCa041B3DC0BF6CD5';
const SIGNER = '0xF2B909e5E2cBc2CFF2d07E02c9b1bAFd0B3A86a2';
const KEY = `0x${'a'.repeat(64)}`;
const CREDS = { key: 'k', secret: 's', passphrase: 'p' };

const posix = process.platform !== 'win32';
let dir: string;
let path: string;

function wallet(overrides: Partial<StoredWallet> = {}): StoredWallet {
  return { version: 1, type: 'deposit', address: ADDRESS, createdAt: 1_750_000_000, ...overrides };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-wallet-'));
  path = join(dir, 'nested', 'wallet.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wallet file permissions', () => {
  test.if(posix)('the wallet is owner-only, in an owner-only directory', () => {
    writeWalletFile(wallet({ signer: SIGNER, privateKey: KEY }), path);
    expect(statSync(path).mode & 0o777).toBe(WALLET_FILE_MODE);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(WALLET_DIR_MODE);
  });

  test.if(posix)('an existing over-permissive file is tightened on rewrite', () => {
    // writeFileSync's `mode` is ignored when the file already exists, so without
    // an explicit chmod a wallet first written by an older build would keep 0644
    // forever.
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(path, '{}', { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    writeWalletFile(wallet(), path);
    expect(statSync(path).mode & 0o777).toBe(WALLET_FILE_MODE);
  });
});

describe('round trip', () => {
  test('a trading wallet survives write and read', () => {
    const w = wallet({ signer: SIGNER, privateKey: KEY });
    writeWalletFile(w, path);
    expect(readWalletFile(path)).toEqual(w);
  });

  test('a watch-only wallet carries no key', () => {
    writeWalletFile(wallet(), path);
    const read = readWalletFile(path);
    expect(read?.privateKey).toBeUndefined();
    expect(read?.signer).toBeUndefined();
    expect(read?.address).toBe(ADDRESS);
  });

  test('a missing file reads as null, not an error', () => {
    expect(readWalletFile(join(dir, 'absent.json'))).toBeNull();
  });

  test('a corrupt file throws rather than degrading to a partial wallet', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(path, 'not json at all');
    expect(() => readWalletFile(path)).toThrow(/Could not read wallet file/);
  });
});

describe('the wallet file is replaced, never truncated', () => {
  /*
   * The guarantee itself — that a crash mid-write cannot leave a truncated file
   * — is structural, not observable from a test: it comes from writing a temp
   * file and renaming over the target, and there is no way to kill the process
   * mid-write from in here. What is checked below is everything around it that
   * a rename-based write could plausibly get wrong.
   */
  test('the replacement is complete and readable', () => {
    writeWalletFile(wallet({ signer: SIGNER, privateKey: KEY }), path);
    writeWalletFile(wallet({ signer: SIGNER, privateKey: KEY, apiCreds: CREDS }), path);

    const after = readWalletFile(path)!;
    expect(after.privateKey).toBe(KEY);
    expect(after.apiCreds).toEqual(CREDS);
  });

  test('no temp file is left beside it', () => {
    writeWalletFile(wallet({ privateKey: KEY }), path);
    writeWalletFile(wallet({ privateKey: KEY, apiCreds: CREDS }), path);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('the replacement is owner-only, not just the first write', () => {
    // The mode argument is ignored for a file that already exists, so a rename
    // that carried the temp file's mode across would be the only thing keeping
    // this true — and it is the second write, not the first, that would slip.
    if (!posix) return;
    writeWalletFile(wallet({ privateKey: KEY }), path);
    writeWalletFile(wallet({ privateKey: KEY, apiCreds: CREDS }), path);
    expect(statSync(path).mode & 0o777).toBe(WALLET_FILE_MODE);
  });
});

describe('rewrites preserve the resolved wallet type', () => {
  test('dropping cached creds does not drop the wallet type with them', () => {
    // `parseStoredWallet` is a whitelist, so any field it does not name is
    // silently lost the next time the file is written — and the file is
    // rewritten whenever CLOB credentials are cached or cleared. The wallet
    // type is resolved once, over the network, at import; losing it here would
    // be invisible until something needed to know what kind of account this is.
    writeWalletFile(wallet({ type: 'deposit', signer: SIGNER, privateKey: KEY, apiCreds: CREDS }), path);

    const read = readWalletFile(path)!;
    expect(read.type).toBe('deposit');

    const { apiCreds: _drop, ...rest } = read;
    writeWalletFile(rest, path);

    const after = readWalletFile(path)!;
    expect(after.type).toBe('deposit');
    expect(after.apiCreds).toBeUndefined();
    expect(after.signer).toBe(SIGNER);
    expect(after.privateKey).toBe(KEY);
  });
});

describe('parseStoredWallet', () => {
  test('rejects anything without a usable address', () => {
    // A wallet that half-parses is the dangerous case: every balance read would
    // report an empty account rather than a broken config.
    expect(() => parseStoredWallet({ version: 1, type: 'proxy' })).toThrow(/no valid address/);
    expect(() => parseStoredWallet({ version: 1, type: 'proxy', address: '0xnope' })).toThrow(
      /no valid address/,
    );
  });

  test('rejects unknown versions and wallet types', () => {
    expect(() => parseStoredWallet({ version: 2, type: 'deposit', address: ADDRESS })).toThrow(
      /unsupported wallet file version/,
    );
    expect(() => parseStoredWallet({ version: 1, type: 'multisig', address: ADDRESS })).toThrow(
      /unsupported wallet type/,
    );
  });

  test('every wallet type Polymarket reports survives a round trip', () => {
    for (const type of ['deposit', 'proxy', 'safe', 'eoa'] as const) {
      expect(parseStoredWallet({ version: 1, type, address: ADDRESS }).type).toBe(type);
    }
  });

  test('an address with no type is kept rather than assigned one', () => {
    // A pasted address resolves nothing, so claiming a type would be a guess
    // recorded as fact.
    const w = parseStoredWallet({ version: 1, address: ADDRESS });
    expect(w.address).toBe(ADDRESS);
    expect(w.type).toBeUndefined();
  });

  test('rejects non-objects', () => {
    expect(() => parseStoredWallet(null)).toThrow(/not a JSON object/);
    expect(() => parseStoredWallet('0x123')).toThrow(/not a JSON object/);
  });
});

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { migrate } from './schema.js';
import { DB_PATH } from '../utils/paths.js';
import { prefetchOctagonEvents } from '../scan/octagon-prefetch.js';

let _db: Database | null = null;

/**
 * Get the database singleton. Lazy-initializes on first call.
 * Pass a custom path for testing (e.g. ":memory:").
 */
export function getDb(path?: string): Database {
  if (_db) return _db;

  const dbPath = path ?? DB_PATH;

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  _db = new Database(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  migrate(_db);

  // Fire-and-forget: prefetch Octagon events in background (only for the real runtime DB)
  if (dbPath === DB_PATH) {
    const db = _db;
    prefetchOctagonEvents(db).catch(() => {});
  }

  return _db;
}

/**
 * Close the database singleton and release the file descriptor.
 * Safe to call even if no DB is open.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Create a fresh database instance (not the singleton).
 * Useful for tests with :memory: databases.
 */
export function createDb(path: string): Database {
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

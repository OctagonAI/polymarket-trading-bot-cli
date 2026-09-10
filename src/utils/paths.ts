import { join } from 'node:path';
import { homedir } from 'node:os';

const APP_DIR = join(homedir(), '.polymarket-bot');

export function getAppDir(): string {
  return APP_DIR;
}

export function appPath(...segments: string[]): string {
  return join(APP_DIR, ...segments);
}

/** Single source of truth for the SQLite cache location. */
export const DB_PATH = join(APP_DIR, 'polymarket-bot.db');

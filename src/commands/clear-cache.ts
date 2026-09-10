import { existsSync, unlinkSync } from 'fs';
import { closeDb } from '../db/index.js';
import { DB_PATH } from '../utils/paths.js';


export function handleClearCache(): { deleted: boolean; path: string; message: string } {
  if (!existsSync(DB_PATH)) {
    return { deleted: false, path: DB_PATH, message: `No cache file found at ${DB_PATH}` };
  }

  // Close the singleton if open so file descriptors are released
  closeDb();

  // Remove WAL/SHM files if present
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  return { deleted: true, path: DB_PATH, message: `Cache cleared: ${DB_PATH}\nA fresh database will be created on next command.` };
}

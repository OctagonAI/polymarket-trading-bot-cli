import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { appPath } from '../../utils/paths.js';

const DEFAULT_PATH = appPath('dlq.jsonl');

export interface DlqEntry {
  ts: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  error: string;
  attempts: number;
}

export class DlqWriter {
  private filePath: string;
  private dirCreated = false;

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH;
  }

  append(entry: Omit<DlqEntry, 'ts'>): void {
    if (!this.dirCreated) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.dirCreated = true;
    }

    const record: DlqEntry = { ts: new Date().toISOString(), ...entry };
    appendFileSync(this.filePath, JSON.stringify(record) + '\n');
  }
}

export const dlqWriter = new DlqWriter();

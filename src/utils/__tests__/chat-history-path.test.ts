import { describe, test, expect } from 'bun:test';
import { isAbsolute, join } from 'path';
import { LongTermChatHistory } from '../long-term-chat-history.js';
import { getAppDir } from '../paths.js';

/** The path is private; reading it is the only way to test it without writing. */
function pathOf(history: LongTermChatHistory): string {
  return (history as unknown as { filePath: string }).filePath;
}

describe('chat history location', () => {
  test('defaults to the app directory, not a path under the working directory', () => {
    // Regression: the constructor took a baseDir defaulting to process.cwd()
    // and did join(baseDir, getAppDir(), ...). path.join does NOT reset on an
    // absolute segment the way path.resolve does, so the app dir was appended
    // rather than used — producing <cwd>/Users/<name>/.polymarket-bot/... and
    // scattering history through whatever directory the CLI was started from.
    const filePath = pathOf(new LongTermChatHistory());

    expect(filePath).toBe(join(getAppDir(), 'messages', 'chat_history.json'));
    expect(isAbsolute(filePath)).toBe(true);
    expect(filePath.startsWith(getAppDir())).toBe(true);
  });

  test('does not nest the home path inside itself', () => {
    const filePath = pathOf(new LongTermChatHistory());
    // The signature of the old bug: the app dir appearing twice, or the home
    // prefix showing up somewhere after the first character.
    expect(filePath.indexOf(getAppDir())).toBe(filePath.lastIndexOf(getAppDir()));
    expect(filePath.slice(1)).not.toContain(getAppDir());
  });
});

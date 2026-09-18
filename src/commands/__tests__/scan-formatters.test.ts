import { describe, test, expect } from 'bun:test';
import { stripVTControlCharacters } from 'node:util';
import { formatTable } from '../scan-formatters.js';

describe('formatTable', () => {
  test('ANSI-colored cells do not skew column alignment', () => {
    const green = (s: string) => `[32m${s}[39m`;
    const out = formatTable(['Name', 'Score'], [
      ['alpha', green(' 77')],
      ['beta', '  —'],
    ]);
    const lines = stripVTControlCharacters(out).split('\n');
    // Every line (borders, header, rows) has the same visible width
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
    // Colors survive — only the measurement ignores them
    expect(out).toContain(green(' 77'));
  });

  test('a cell containing a newline does not split the row', () => {
    const out = formatTable(['Event', 'Title'], [
      ['a-slug', ' a title with a trailing newline\n'],
      ['b-slug', 'a title  with  doubled  spaces'],
    ]);
    const lines = out.split('\n');
    // top border, header, mid border, two data rows, bottom border
    expect(lines.length).toBe(6);
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  test('a table wider than the budget is shrunk to fit', () => {
    const out = formatTable(
      ['Slug', 'Title', 'Last'],
      [['a-fairly-long-event-slug', 'a fairly long descriptive title', '$0.17']],
      40,
    );
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
    expect(out).toContain('\u2026');
  });

  test('a six-column table still fits a narrow budget', () => {
    // Regression: the shrink loop used to stop at an eight-character floor, so
    // six columns bottomed out at 6 * 8 + 19 = 67 and overflowed any budget
    // below that while claiming to fit.
    const out = formatTable(
      ['A', 'B', 'C', 'D', 'E', 'F'],
      [['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee', 'ffffffffffff']],
      50,
    );
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(50);
  });

  test('no budget leaves output at natural width', () => {
    const wide = formatTable(['A', 'B'], [['alpha', 'a fairly long descriptive title here']], Infinity);
    expect(wide.split('\n')[0].length).toBe(5 + 36 + 3 * 2 + 1);
    expect(wide).not.toContain('\u2026');
  });

  test('truncating a coloured cell emits a real reset, not literal text', () => {
    // Regression: the ESC bytes were lost from truncateVisible, so the regex
    // never matched a colour code and the appended reset was the plain text
    // "[0m", which printed verbatim in the table.
    const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
    const out = formatTable(['A'], [[green('a very long coloured value that must shrink')]], 20);
    expect(out).toContain('\u001b[0m');
    // Nothing resembling an escape survives once real escapes are stripped
    expect(stripVTControlCharacters(out)).not.toContain('[0m');
    expect(stripVTControlCharacters(out).split('\n').every((l) => l.length <= 20)).toBe(true);
  });
});

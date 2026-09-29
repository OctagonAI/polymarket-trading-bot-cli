/**
 * Each contract's own identity within one event: its market slug minus the
 * hyphen-words that every sibling shares.
 *
 * The Kalshi CLI strips the event ticker, which prefixes every Kalshi market
 * ticker. Polymarket slugs mostly don't start with the event slug
 * (`will-dan-sullivan-win-the-alaska-senate-race-in-2026` under
 * `alaska-senate-election-winner`), but siblings still share a template, so
 * the shared leading and trailing words are stripped instead:
 * `bitcoin-above-66k-on-september-23-2026` → `66k`. When the siblings do start
 * with the event slug this reduces to the Kalshi rule.
 *
 * Takes bare slugs (no `polymarket__` prefix); returns labels in input order.
 */
export function contractLabels(marketSlugs: string[], eventSlug: string): string[] {
  // The event's own market (a moneyline, a lone yes/no) is kept whole and left
  // out of the comparison: it shares only the event words with its siblings.
  const siblings = marketSlugs.filter((s) => s !== eventSlug).map((s) => s.split('-'));
  if (siblings.length < 2) {
    // A lone slug shares every word with itself; only the event prefix is known to be common.
    const prefix = `${eventSlug}-`;
    return marketSlugs.map((s) => (s.startsWith(prefix) ? s.slice(prefix.length) : s));
  }

  const lead = sharedWords(siblings, (w, i) => w[i]);
  const trail = sharedWords(siblings.map((w) => w.slice(lead)), (w, i) => w[w.length - 1 - i]);
  return marketSlugs.map((s) =>
    s === eventSlug ? s : s.split('-').slice(lead, trail > 0 ? -trail : undefined).join('-'),
  );
}

/** How many words, read by `at`, every row shares — leaving each row at least one. */
function sharedWords(rows: string[][], at: (words: string[], i: number) => string): number {
  const max = Math.min(...rows.map((r) => r.length)) - 1;
  let n = 0;
  while (n < max && rows.every((r) => at(r, n) === at(rows[0], n))) n++;
  return n;
}

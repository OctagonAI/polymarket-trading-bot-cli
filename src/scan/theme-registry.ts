/**
 * The one theme vocabulary the CLI exposes.
 *
 * A theme has to resolve against two different backends, which disagree about
 * labels, so each entry carries both:
 *
 *  - `metaCategory` — Octagon's cross-venue taxonomy, used by `search` against
 *    `/predictions/markets/events/search?meta_category=`. This is a CLOSED set
 *    of 11 values (octagon-api `taxonomy/categories.py`, enforced by tests
 *    there), and the filter is CASE-SENSITIVE: `meta_category=crypto` returns
 *    zero rows rather than an error. Never build one of these from user input.
 *
 *  - `tags` — Polymarket's own free-form Gamma tag labels, matched against the
 *    local `event_index` by `scan --theme` and the TUI browse view.
 *
 * The two vocabularies line up for most themes but not all: Octagon says
 * `Climate` where Gamma tags say `Weather`, and Octagon's single
 * `Tech & Science` is two separate Gamma tags. That mismatch is why one string
 * per theme cannot serve both backends.
 *
 * Themes absent here on purpose: `health` and `transportation` matched zero
 * events in either vocabulary, and Octagon has no meta category for them.
 */

export interface Theme {
  /** Lowercase, user-facing. What someone types after `search`. */
  id: string;
  /** Octagon meta category — EXACT case, one of the canonical 11. */
  metaCategory: MetaCategory;
  /** Gamma tag labels for the local index. May be several per theme. */
  tags: string[];
}

/**
 * Octagon's closed category vocabulary. Mirrors `MetaCategory` in
 * octagon-api `taxonomy/categories.py`; a venue inventing a new category does
 * not silently add one here.
 */
export const META_CATEGORIES = [
  'Politics',
  'Elections',
  'Economics',
  'Finance',
  'Crypto',
  'Commodities',
  'Sports',
  'Culture',
  'Tech & Science',
  'Climate',
  'Mentions',
] as const;

export type MetaCategory = (typeof META_CATEGORIES)[number];

/** The theme table, ordered as it should be displayed. */
export const THEMES: Theme[] = [
  { id: 'politics', metaCategory: 'Politics', tags: ['Politics', 'Geopolitics'] },
  { id: 'elections', metaCategory: 'Elections', tags: ['Elections'] },
  { id: 'economics', metaCategory: 'Economics', tags: ['Economy'] },
  { id: 'finance', metaCategory: 'Finance', tags: ['Finance', 'Business'] },
  { id: 'crypto', metaCategory: 'Crypto', tags: ['Crypto'] },
  { id: 'commodities', metaCategory: 'Commodities', tags: ['Commodities'] },
  { id: 'sports', metaCategory: 'Sports', tags: ['Sports'] },
  { id: 'culture', metaCategory: 'Culture', tags: ['Culture'] },
  { id: 'tech-science', metaCategory: 'Tech & Science', tags: ['Tech', 'Science'] },
  { id: 'climate', metaCategory: 'Climate', tags: ['Weather'] },
  { id: 'mentions', metaCategory: 'Mentions', tags: ['Mentions'] },
];

/**
 * Older theme ids, kept working so existing scripts and habits don't break.
 * `world` folds into `politics` because Gamma's `Geopolitics` tag has no
 * meta category of its own — Octagon files those events under `Politics`.
 */
const ALIASES: Record<string, string> = {
  entertainment: 'culture',
  social: 'culture',
  companies: 'finance',
  financials: 'finance',
  science: 'tech-science',
  world: 'politics',
};

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** The pseudo-theme handled by ThemeResolver rather than by category lookup. */
export const TOP50 = 'top50';

/** Resolve a theme id or legacy alias. Returns undefined for free text. */
export function findTheme(input: string): Theme | undefined {
  const key = input.trim().toLowerCase();
  return BY_ID.get(ALIASES[key] ?? key);
}

/** True for any recognised theme id or alias, including `top50`. */
export function isThemeId(input: string): boolean {
  const key = input.trim().toLowerCase();
  return key === TOP50 || findTheme(key) !== undefined;
}

/** Every id a user may type, canonical first. Used for autocomplete and help. */
export function allThemeIds(): string[] {
  return [TOP50, ...THEMES.map((t) => t.id), ...Object.keys(ALIASES)];
}

/**
 * Theme id → primary Gamma tag label, for callers that still want the old
 * flat shape. Prefer `findTheme().tags`, which keeps every label.
 */
export function themeTagLabels(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const theme of THEMES) out[theme.id] = theme.tags;
  return out;
}

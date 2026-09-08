/**
 * What Octagon can answer for Polymarket today.
 *
 * Two distinct reasons a feature can be unavailable:
 *
 *  - `unported`  Octagon has a venue-generic endpoint that supports Polymarket
 *                (`/v1/predictions/*` with `venue=polymarket`), but this client
 *                still calls the deprecated Kalshi-scoped
 *                `/v1/prediction-markets/kalshi/*` routes. Repointing the client
 *                enables these — that is the next phase of the port.
 *
 *  - `kalshi-only`  Octagon exposes no venue-generic equivalent at all. These
 *                stay unavailable until Octagon ships one.
 *
 * The distinction matters: the first group is our work, the second is not.
 * Both are gated here rather than left to return Kalshi rows under a Polymarket
 * banner, which is how this surfaced in the first place.
 */

export type OctagonFeature =
  // Venue-generic endpoint exists; blocked only until the client is repointed.
  | 'market-search'
  | 'similar-markets'
  | 'events'
  | 'reports'
  | 'trader-trust'
  // No venue-generic equivalent on Octagon.
  | 'clusters'
  | 'cluster-peers'
  | 'correlations'
  | 'baskets'
  | 'series-rollup'
  | 'batch-edge';

type Reason = 'unported' | 'kalshi-only';

const FEATURE_REASON: Record<OctagonFeature, Reason> = {
  'market-search': 'unported',
  'similar-markets': 'unported',
  events: 'unported',
  reports: 'unported',
  'trader-trust': 'unported',
  clusters: 'kalshi-only',
  'cluster-peers': 'kalshi-only',
  correlations: 'kalshi-only',
  baskets: 'kalshi-only',
  'series-rollup': 'kalshi-only',
  'batch-edge': 'kalshi-only',
};

/**
 * Every Octagon feature is currently unavailable for Polymarket, because the
 * client still targets the Kalshi-scoped routes. Repointing it flips the
 * `unported` group on; this predicate is the single place that changes.
 */
export function octagonSupports(_feature: OctagonFeature): boolean {
  return false;
}

export function octagonUnavailableMessage(feature: OctagonFeature, command: string): string {
  const reason = FEATURE_REASON[feature];
  if (reason === 'unported') {
    return (
      `\`${command}\` is not available for Polymarket yet.\n\n` +
      `Octagon supports Polymarket on its venue-generic API, but this CLI still calls the ` +
      `Kalshi-scoped routes — so running it would return Kalshi markets. It is enabled once ` +
      `the Octagon client is repointed.`
    );
  }
  return (
    `\`${command}\` is not available for Polymarket.\n\n` +
    `Octagon exposes clustering, correlation, basket construction and series rollups for ` +
    `Kalshi only; there is no Polymarket equivalent to call yet.`
  );
}

/** Commands hidden from help, autocomplete and the intro list while gated. */
export const DEFERRED_COMMANDS = [
  'similar',
  'clusters',
  'peers',
  'correlate',
  'basket',
  'events',
  'series',
  'trust',
  'report',
] as const;

export function isDeferredCommand(name: string): boolean {
  return (DEFERRED_COMMANDS as readonly string[]).includes(name);
}

/** Maps a deferred command to the capability it needs. */
export const COMMAND_FEATURE: Record<string, OctagonFeature> = {
  similar: 'similar-markets',
  clusters: 'clusters',
  peers: 'cluster-peers',
  correlate: 'correlations',
  basket: 'baskets',
  events: 'events',
  series: 'series-rollup',
  trust: 'trader-trust',
  report: 'reports',
};

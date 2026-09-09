/**
 * What Octagon can answer for Polymarket today.
 *
 * Two distinct reasons a feature can be unavailable:
 *
 *  - `unported`  Octagon has a venue-generic endpoint that supports Polymarket
 *                (`/v1/predictions/*` with `venue=polymarket`) and this client
 *                now calls it. These features are live.
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
 * The client now calls the venue-generic `/v1/predictions/*` routes, so every
 * feature with a Polymarket-capable endpoint is live. What remains false is
 * exactly the set Octagon serves for Kalshi only.
 */
export function octagonSupports(feature: OctagonFeature): boolean {
  return FEATURE_REASON[feature] !== 'kalshi-only';
}

export function octagonUnavailableMessage(feature: OctagonFeature, command: string): string {
  const reason = FEATURE_REASON[feature];
  if (reason === 'unported') {
    return `\`${command}\` is not available for Polymarket yet.`;
  }
  // Deliberately does not name the venue Octagon *does* serve these for. This is
  // a Polymarket product; the other venue is not the user's concern, and the
  // actionable fact is simply that Octagon has no Polymarket route for it.
  return (
    `\`${command}\` is not available for Polymarket.\n\n` +
    `Octagon does not expose clustering, correlation, basket construction or series ` +
    `rollups for Polymarket, so there is no data to build this from.`
  );
}

/**
 * Commands hidden from help, autocomplete and the intro list while gated.
 * Every one of these needs an Octagon capability that exists for Kalshi only.
 */
export const DEFERRED_COMMANDS = [
  'clusters',
  'peers',
  'correlate',
  'basket',
  'series',
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

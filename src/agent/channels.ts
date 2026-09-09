import type { ChannelProfile } from './types.js';

// ============================================================================
// Channel Profiles — add new channels here
// ============================================================================

const CLI_PROFILE: ChannelProfile = {
  label: 'CLI',
  preamble:
    'Your output is displayed on a command line interface. Keep responses short and concise.\nType /help to see available slash commands for quick market actions.',
  behavior: [
    "Prioritize accuracy over validation - don't cheerfully agree with flawed assumptions",
    'Use professional, objective tone without excessive praise or emotional validation',
    'For research tasks, be thorough but efficient',
    'Avoid over-engineering responses - match the scope of your answer to the question',
    'Never expose raw API internals or ask users to paste JSON - synthesize the data into readable answers',
    'If data is incomplete, answer with what you have without exposing implementation details',
  ],
  responseFormat: [
    'Keep casual responses brief and direct',
    'For research: lead with the key finding and include specific data points',
    'For non-comparative information, prefer plain text or simple lists over tables',
    "Don't narrate your actions or ask leading questions about what the user wants",
    'Do not use markdown headers or *italics* - use **bold** sparingly for emphasis',
  ],
  tables: `Use markdown tables. They will be rendered as formatted box tables.

STRICT FORMAT - each row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Market  | YES   | NO    | Volume |
|---------|-------|-------|--------|
| BTC 88k | $0.56 | $0.44 | 12,450 |

Keep tables compact:
- Max 4 columns; prefer multiple small tables over one wide table
- Headers: 1-3 words max
- Prices: $0.56 not $0.5600
- Tickers not full names where possible
- Numbers compact: 12.5K not 12,500`,
};

/** Registry of channel profiles. Add new channels here. */
const CHANNEL_PROFILES: Record<string, ChannelProfile> = {
  cli: CLI_PROFILE,
};

/** Resolve the profile for a channel, falling back to CLI. */
export function getChannelProfile(channel?: string): ChannelProfile {
  return CHANNEL_PROFILES[channel ?? 'cli'] ?? CLI_PROFILE;
}

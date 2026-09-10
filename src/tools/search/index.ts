/**
 * Rich description for the web_search tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.

## When to Use

- Background research on real-world events behind prediction markets
- Current events, breaking news, recent developments
- Verifying claims about real-world state
- Researching topics to inform market analysis

## When NOT to Use

- Polymarket market data (use polymarket_search instead)
- Questions you can answer from knowledge

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
`.trim();

export { tavilySearch } from './tavily.js';

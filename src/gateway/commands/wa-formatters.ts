import type { ScanResult } from '../../scan/loop.js';
import type { PortfolioData } from '../../commands/portfolio.js';
import type { EdgeRow } from '../../db/edge.js';

const MAX_ITEMS = 8;

export function formatScanForWhatsApp(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(`*SCAN COMPLETE*`);
  lines.push(`Events: ${result.eventsScanned} | Edges: ${result.edgeSnapshots.length} | Alerts: ${result.alerts.length}`);
  lines.push('');

  const actionable = result.edgeSnapshots
    .filter((s) => s.confidence === 'high' || s.confidence === 'very_high')
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
    .slice(0, MAX_ITEMS);

  if (actionable.length === 0) {
    lines.push('No actionable edges found.');
  } else {
    lines.push('*Top Edges:*');
    for (const snap of actionable) {
      const sign = snap.edge >= 0 ? '+' : '';
      const edgePct = `${sign}${(snap.edge * 100).toFixed(1)}%`;
      const conf = snap.confidence === 'very_high' ? 'V.HIGH' : snap.confidence.toUpperCase();
      lines.push(`• *${snap.ticker}* ${edgePct} (${conf})`);
      if (snap.drivers[0]) {
        lines.push(`  _${snap.drivers[0].claim}_`);
      }
    }
  }

  lines.push('');
  lines.push(`Duration: ${(result.duration / 1000).toFixed(1)}s | Credits: ${result.octagonCreditsUsed}`);
  return lines.join('\n');
}

export function formatEdgeForWhatsApp(rows: EdgeRow[]): string {
  const lines: string[] = [];
  lines.push(`*EDGE SNAPSHOT*`);
  lines.push('');

  const sorted = [...rows]
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
    .slice(0, MAX_ITEMS);

  if (sorted.length === 0) {
    lines.push('No edges found.');
  } else {
    for (const row of sorted) {
      const sign = row.edge >= 0 ? '+' : '';
      const edgePct = `${sign}${(row.edge * 100).toFixed(1)}%`;
      const conf = row.confidence === 'very_high' ? 'V.HIGH' : (row.confidence ?? 'N/A').toUpperCase();
      lines.push(`• *${row.ticker}* ${edgePct} (${conf})`);
    }
  }

  return lines.join('\n');
}

export function formatPortfolioForWhatsApp(data: PortfolioData): string {
  const lines: string[] = [];
  lines.push(`*PORTFOLIO*`);
  lines.push('');

  const acct = data.accountSummary;
  if (acct) {
    lines.push(`Cash: $${acct.cashBalance.toFixed(2)}`);
    lines.push(`Portfolio: $${acct.portfolioValue.toFixed(2)}`);
    lines.push(`Exposure: $${acct.openExposure.toFixed(2)}`);
    lines.push(`Available: $${acct.available.toFixed(2)}`);
  } else {
    lines.push(`Account data unavailable`);
  }
  lines.push('');

  if (data.positions.length === 0) {
    lines.push('No open positions.');
  } else {
    lines.push(`*Positions (${data.positions.length}):*`);
    for (const p of data.positions.slice(0, MAX_ITEMS)) {
      const edgeTxt = p.currentEdge !== null ? `${(p.currentEdge * 100).toFixed(1)}%` : '-';
      const pnlTxt = p.unrealizedPnl !== null ? `$${p.unrealizedPnl.toFixed(2)}` : '-';
      lines.push(`• *${p.ticker}* ${p.direction.toUpperCase()} x${p.size} | Edge: ${edgeTxt} | P&L: ${pnlTxt}`);
    }
    if (data.positions.length > MAX_ITEMS) {
      lines.push(`  _...and ${data.positions.length - MAX_ITEMS} more_`);
    }
  }

  return lines.join('\n');
}

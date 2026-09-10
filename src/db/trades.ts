import type { Database } from 'bun:sqlite';

export interface Trade {
  trade_id: string;
  position_id?: string | null;
  order_id?: string | null;
  ticker: string;
  action: string;
  side: string;
  size: number;
  price: number;
  fill_status?: string | null;
  raw_response?: string | null;
  created_at?: number | null;
}

export function logTrade(db: Database, trade: Trade): void {
  db.prepare(`
    INSERT INTO trades
      (trade_id, position_id, order_id, ticker, action, side, size, price,
       fill_status, raw_response, created_at)
    VALUES
      ($trade_id, $position_id, $order_id, $ticker, $action, $side, $size, $price,
       $fill_status, $raw_response, $created_at)
  `).run({
    $trade_id: trade.trade_id,
    $position_id: trade.position_id ?? null,
    $order_id: trade.order_id ?? null,
    $ticker: trade.ticker,
    $action: trade.action,
    $side: trade.side,
    $size: trade.size,
    $price: trade.price,
    $fill_status: trade.fill_status ?? null,
    $raw_response: trade.raw_response ?? null,
    $created_at: trade.created_at ?? null,
  });
}

export function getTradesForPosition(db: Database, positionId: string): Trade[] {
  return db.query('SELECT * FROM trades WHERE position_id = $id').all({
    $id: positionId,
  }) as Trade[];
}

export function getRecentTrades(db: Database, limit: number): Trade[] {
  return db.query('SELECT * FROM trades ORDER BY created_at DESC LIMIT $limit').all({
    $limit: limit,
  }) as Trade[];
}

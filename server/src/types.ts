export type Mode = 'paper' | 'real';
export type Side = 'BUY' | 'SELL';

export interface Quote {
  symbol: string;
  ltp: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** epoch ms */
  ts: number;
}

export interface Candle {
  /** epoch ms of candle start */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  /** Market order when undefined */
  limitPrice?: number;
  /** Free text: why this order was sent (shown in the daily report) */
  reason: string;
}

export interface OrderResult {
  orderId: string;
  status: 'filled' | 'open' | 'rejected';
  avgPrice?: number;
  filledQty: number;
  message?: string;
}

export interface MarginInfo {
  symbol: string;
  /** How many times your cash you can take intraday (MIS). 1 means no leverage. */
  leverage: number;
  /** Money blocked for one share at the given price */
  marginPerShare: number;
}

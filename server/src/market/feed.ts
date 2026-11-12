import type { Candle, Quote } from '../types.ts';

/** Source of live prices and candles. */
export interface PriceFeed {
  readonly name: string;
  start(symbols: readonly string[], onQuotes: (quotes: Quote[]) => void): Promise<void>;
  stop(): void;
  /** Find shares by name start / contains (for the search box). */
  search(query: string, limit?: number): string[];
  /** Start following one more share (any share, not only the chosen list). Returns false if the broker does not know it. */
  watch(symbol: string): Promise<boolean>;
  getCandles(symbol: string, interval: '1minute' | 'day', days: number): Promise<Candle[]>;
  /** 1-minute candles of the last `days` calendar days including earlier days (only the Upstox feed has this) */
  getMinuteHistory?(symbol: string, days: number): Promise<Candle[]>;
}

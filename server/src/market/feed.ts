import type { Candle, Quote } from '../types.ts';

/** Source of live prices and candles. */
export interface PriceFeed {
  readonly name: string;
  start(symbols: readonly string[], onQuotes: (quotes: Quote[]) => void): Promise<void>;
  stop(): void;
  getCandles(symbol: string, interval: '1minute' | 'day', days: number): Promise<Candle[]>;
}

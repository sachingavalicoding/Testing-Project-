import type { Candle, Quote } from '../types.ts';
import type { PriceFeed } from './feed.ts';

/** Small deterministic random generator so the same symbol always starts at the same price. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Fake prices for testing the app without a broker login (weekends, phone, CI).
 * Each share does a small random walk around a stable base price.
 */
export class MockFeed implements PriceFeed {
  readonly name = 'mock';
  private timer: NodeJS.Timeout | undefined;
  private state = new Map<string, Quote>();
  private rand = seeded(Date.now());

  constructor(private readonly intervalMs = 1000) {}

  basePrice(symbol: string): number {
    const r = seeded(hash(symbol));
    return Math.round((100 + r() * 3900) * 20) / 20;
  }

  async start(symbols: readonly string[], onQuotes: (q: Quote[]) => void): Promise<void> {
    const now = Date.now();
    for (const symbol of symbols) {
      const prevClose = this.basePrice(symbol);
      const open = round(prevClose * (1 + (this.rand() - 0.5) * 0.02));
      this.state.set(symbol, { symbol, ltp: open, prevClose, open, high: open, low: open, volume: 0, ts: now });
    }
    onQuotes([...this.state.values()]);
    this.timer = setInterval(() => onQuotes(this.tick()), this.intervalMs);
  }

  private tick(): Quote[] {
    const now = Date.now();
    const out: Quote[] = [];
    for (const q of this.state.values()) {
      const ltp = round(q.ltp * (1 + (this.rand() - 0.5) * 0.004));
      const next: Quote = {
        ...q,
        ltp,
        high: Math.max(q.high, ltp),
        low: Math.min(q.low, ltp),
        volume: q.volume + Math.floor(this.rand() * 5000),
        ts: now,
      };
      this.state.set(q.symbol, next);
      out.push(next);
    }
    return out;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getCandles(symbol: string, interval: '1minute' | 'day', days: number): Promise<Candle[]> {
    const step = interval === 'day' ? 86_400_000 : 60_000;
    const count = interval === 'day' ? days : Math.min(days * 375, 375 * 5);
    const r = seeded(hash(symbol + interval));
    let price = this.basePrice(symbol);
    const end = Math.floor(Date.now() / step) * step;
    const candles: Candle[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const vol = interval === 'day' ? 0.02 : 0.002;
      const o = price;
      const c = round(o * (1 + (r() - 0.5) * vol));
      const h = round(Math.max(o, c) * (1 + r() * vol * 0.3));
      const l = round(Math.min(o, c) * (1 - r() * vol * 0.3));
      candles.push({ t: end - i * step, o, h, l, c, v: Math.floor(r() * 100_000) });
      price = c;
    }
    return candles;
  }
}

function round(n: number): number {
  return Math.round(n * 20) / 20; // NSE tick size 0.05
}

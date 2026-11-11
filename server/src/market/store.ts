import type { Candle, Quote } from '../types.ts';

export interface Mover {
  symbol: string;
  ltp: number;
  changePct: number;
  volume: number;
}

/**
 * Latest price for every share plus 1-minute candles built from the live ticks
 * (so patterns can run without asking the broker for history every minute).
 */
export class MarketStore {
  private quotes = new Map<string, Quote>();
  private candles = new Map<string, Candle[]>();
  private lastVolume = new Map<string, number>();

  constructor(private readonly maxCandles = 400) {}

  /** Forget everything (used when the share list changes). */
  clear(): void {
    this.quotes.clear();
    this.candles.clear();
    this.lastVolume.clear();
  }

  update(quotes: Quote[]): void {
    for (const q of quotes) {
      this.quotes.set(q.symbol, q);
      this.addTick(q);
    }
  }

  private addTick(q: Quote): void {
    const t = Math.floor(q.ts / 60_000) * 60_000;
    const prevVol = this.lastVolume.get(q.symbol);
    const dv = prevVol === undefined ? 0 : Math.max(0, q.volume - prevVol);
    this.lastVolume.set(q.symbol, q.volume);
    let list = this.candles.get(q.symbol);
    if (!list) this.candles.set(q.symbol, (list = []));
    const last = list[list.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, q.ltp);
      last.l = Math.min(last.l, q.ltp);
      last.c = q.ltp;
      last.v += dv;
    } else {
      list.push({ t, o: q.ltp, h: q.ltp, l: q.ltp, c: q.ltp, v: dv });
      if (list.length > this.maxCandles) list.shift();
    }
  }

  /**
   * Add earlier candles (today's history from the broker) in front of the ones built from live ticks.
   * Where both have the same minute, the history keeps its open and volume and the live tick keeps the latest close.
   */
  seedCandles(symbol: string, history: Candle[]): void {
    const live = this.candles.get(symbol) ?? [];
    const byT = new Map<number, Candle>();
    for (const c of history) byT.set(c.t, { ...c });
    for (const c of live) {
      const h = byT.get(c.t);
      byT.set(c.t, h ? { t: c.t, o: h.o, h: Math.max(h.h, c.h), l: Math.min(h.l, c.l), c: c.c, v: Math.max(h.v, c.v) } : c);
    }
    this.candles.set(symbol, [...byT.values()].sort((a, b) => a.t - b.t).slice(-this.maxCandles));
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  allQuotes(): Quote[] {
    return [...this.quotes.values()];
  }

  candlesFor(symbol: string): Candle[] {
    return this.candles.get(symbol) ?? [];
  }

  movers(limit = 10): { gainers: Mover[]; losers: Mover[] } {
    const rows: Mover[] = this.allQuotes()
      .filter((q) => q.prevClose > 0)
      .map((q) => ({
        symbol: q.symbol,
        ltp: q.ltp,
        changePct: Math.round(((q.ltp - q.prevClose) / q.prevClose) * 10_000) / 100,
        volume: q.volume,
      }));
    const sorted = rows.sort((a, b) => b.changePct - a.changePct);
    return {
      gainers: sorted.filter((r) => r.changePct > 0).slice(0, limit),
      losers: sorted.filter((r) => r.changePct < 0).reverse().slice(0, limit),
    };
  }
}

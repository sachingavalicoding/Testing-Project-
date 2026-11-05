import type { Candle, Quote } from '../types.ts';
import { ema, sma } from './indicators.ts';
import { istMinutes, MARKET_OPEN } from '../market/time.ts';

export interface Signal {
  pattern: string;
  /** Plain words: why this fired. Saved with the trade for the daily report. */
  reason: string;
  /** Suggested stop distance as a fraction (0.01 = 1%) */
  stopPct: number;
  /** 0-100, higher is stronger */
  score: number;
}

export interface Pattern {
  id: string;
  name: string;
  check(quote: Quote, candles: Candle[]): Signal | undefined;
}

/** Only completed candles (drop the minute still forming). */
function closed(candles: Candle[], now: number): Candle[] {
  const current = Math.floor(now / 60_000) * 60_000;
  return candles.filter((c) => c.t < current);
}

/**
 * Opening range breakout: after the first 15 minutes, buy when price breaks the
 * high of those 15 minutes with above-average volume.
 */
export const openingRangeBreakout: Pattern = {
  id: 'orb15',
  name: 'Opening range breakout (15 min)',
  check(q, all) {
    const mins = istMinutes(q.ts);
    if (mins < MARKET_OPEN + 15 || mins > MARKET_OPEN + 120) return undefined;
    const today = all.filter((c) => istMinutes(c.t) >= MARKET_OPEN && sameDay(c.t, q.ts));
    const range = today.filter((c) => istMinutes(c.t) < MARKET_OPEN + 15);
    if (range.length < 10) return undefined;
    const high = Math.max(...range.map((c) => c.h));
    const low = Math.min(...range.map((c) => c.l));
    const done = closed(today, q.ts);
    const last = done[done.length - 1];
    if (!last || last.c <= high) return undefined;
    // Must be a fresh break: the candle before closed inside the range.
    const before = done[done.length - 2];
    if (before && before.c > high) return undefined;
    const avgVol = sma(done.slice(0, -1).map((c) => c.v), Math.min(20, done.length - 1)) ?? 0;
    if (avgVol > 0 && last.v < avgVol * 1.2) return undefined;
    const rangePct = (high - low) / high;
    return {
      pattern: this.id,
      reason: `Broke 15-min high ${high.toFixed(2)} (range ${(rangePct * 100).toFixed(2)}%) on volume ${Math.round(last.v)} vs avg ${Math.round(avgVol)}`,
      stopPct: clamp(rangePct, 0.005, 0.015),
      score: 60 + Math.min(30, Math.round((last.v / Math.max(1, avgVol)) * 5)),
    };
  },
};

/** EMA 9 crosses above EMA 21 on 1-minute closes while price is above the day open. */
export const emaCross: Pattern = {
  id: 'ema9x21',
  name: 'EMA 9/21 cross up',
  check(q, all) {
    const done = closed(all, q.ts);
    if (done.length < 30) return undefined;
    const closes = done.map((c) => c.c);
    const fast = ema(closes, 9);
    const slow = ema(closes, 21);
    const n = closes.length - 1;
    const crossed = fast[n] > slow[n] && fast[n - 1] <= slow[n - 1];
    if (!crossed || q.ltp < q.open) return undefined;
    return {
      pattern: this.id,
      reason: `EMA9 ${fast[n].toFixed(2)} crossed above EMA21 ${slow[n].toFixed(2)}; price above day open ${q.open}`,
      stopPct: 0.01,
      score: 55,
    };
  },
};

export const PATTERNS: Pattern[] = [openingRangeBreakout, emaCross];

function sameDay(a: number, b: number): boolean {
  const off = 5.5 * 3600_000;
  return Math.floor((a + off) / 86_400_000) === Math.floor((b + off) / 86_400_000);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

import type { Candle, Quote } from '../types.ts';
import { ema, sma, vwap } from './indicators.ts';
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

/**
 * Momentum breakout for shares already running (built for mid/small caps that move 5-10% in a day).
 * Buys when the share is up 2%+ on the day, a 1-minute candle closes above the previous 20 candles' high
 * (a fresh break, not one already running) and volume is at least 2x the recent average.
 */
export const momentumBreakout: Pattern = {
  id: 'mom',
  name: 'Momentum breakout (up 2%+, volume surge)',
  check(q, all) {
    const mins = istMinutes(q.ts);
    if (mins < MARKET_OPEN + 30 || mins > 14 * 60 + 30) return undefined;
    if (q.prevClose <= 0) return undefined;
    const dayPct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
    if (dayPct < 2) return undefined;
    const done = closed(all, q.ts);
    if (done.length < 25) return undefined;
    const last = done[done.length - 1];
    const before = done[done.length - 2];
    const prior = done.slice(-21, -1);
    const priorHigh = Math.max(...prior.map((c) => c.h));
    const priorLow = Math.min(...prior.map((c) => c.l));
    if (last.c <= priorHigh || before.c > priorHigh) return undefined;
    const avgVol = sma(prior.map((c) => c.v), prior.length) ?? 0;
    if (avgVol > 0 && last.v < avgVol * 2) return undefined;
    const rangePct = (priorHigh - priorLow) / priorHigh;
    return {
      pattern: this.id,
      reason: `Up ${dayPct.toFixed(1)}% today, 1-min close ${last.c} broke the 20-candle high ${priorHigh.toFixed(2)} on volume ${Math.round(last.v)} vs avg ${Math.round(avgVol)}`,
      stopPct: clamp(rangePct / 2, 0.01, 0.03),
      score: 55 + Math.min(35, Math.round(dayPct * 3)),
    };
  },
};

/**
 * VWAP / EMA pullback bounce (trend continuation). The share is already up on the day and trending up
 * (EMA9 above EMA21). It dipped back to its support (VWAP or EMA21), and now a green candle closes back
 * above EMA9. The stop sits just under the pullback low, so it is tight, and the move back to the day's
 * high is usually 1%+. This gives many more entries than the opening range alone.
 */
export const vwapPullback: Pattern = {
  id: 'vwappb',
  name: 'VWAP / EMA pullback bounce',
  check(q, all) {
    const mins = istMinutes(q.ts);
    if (mins < MARKET_OPEN + 25 || mins > 14 * 60 + 15) return undefined;
    if (q.prevClose <= 0) return undefined;
    const dayPct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
    if (dayPct < 0.2 || dayPct > 3) return undefined;
    const today = closed(all.filter((c) => sameDay(c.t, q.ts)), q.ts);
    if (today.length < 25) return undefined;
    const closes = today.map((c) => c.c);
    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const n = closes.length - 1;
    const last = today[n];
    const before = today[n - 1];
    if (!(e9[n] > e21[n])) return undefined;
    // The bounce: previous candle was still below EMA9 (pulling back), this one is green and closes back above it.
    if (!(last.c > last.o && last.c > e9[n] && before.c <= e9[n - 1])) return undefined;
    const vw = vwap(today);
    if (vw !== undefined && q.ltp < vw) return undefined;
    // The dip really touched support in the last 6 candles: EMA21 or VWAP.
    const recent = today.slice(-6);
    const touched = recent.some((c, i) => c.l <= e21[n - 5 + i] * 1.001 || (vw !== undefined && c.l <= vw * 1.0015));
    if (!touched) return undefined;
    const avgVol = sma(today.slice(-21, -1).map((c) => c.v), 20) ?? 0;
    const volRatio = avgVol > 0 ? last.v / avgVol : 1;
    // A bounce on thin volume is usually just a pause before the next leg down.
    if (volRatio < 1.2) return undefined;
    const stopLow = Math.min(...today.slice(-4).map((c) => c.l));
    return {
      pattern: this.id,
      reason: `Up ${dayPct.toFixed(1)}% and trending up; dipped to support and bounced above EMA9 ${e9[n].toFixed(2)} (VWAP ${vw?.toFixed(2) ?? '-'}), volume ${volRatio.toFixed(1)}x`,
      stopPct: clamp((q.ltp - stopLow) / q.ltp + 0.0005, 0.004, 0.01),
      score: 60 + Math.min(15, Math.round(dayPct * 5)) + Math.min(10, Math.round((volRatio - 1) * 10)),
    };
  },
};

/**
 * Tight range breakout. The share rests in a very narrow range for 12 minutes (under 0.5% high to low),
 * then a 1-minute candle closes above that range on 1.5x volume, with price above VWAP. Energy built up
 * during the rest is released. The stop is the bottom of the range, so it is small by nature.
 */
export const tightRangeBreakout: Pattern = {
  id: 'squeeze',
  name: 'Tight range breakout',
  check(q, all) {
    const mins = istMinutes(q.ts);
    if (mins < MARKET_OPEN + 30 || mins > 14 * 60 + 15) return undefined;
    if (q.prevClose <= 0) return undefined;
    const dayPct = ((q.ltp - q.prevClose) / q.prevClose) * 100;
    if (dayPct < -0.2 || dayPct > 3) return undefined;
    const today = closed(all.filter((c) => sameDay(c.t, q.ts)), q.ts);
    if (today.length < 20) return undefined;
    const last = today[today.length - 1];
    const before = today[today.length - 2];
    const base = today.slice(-13, -1);
    const hi = Math.max(...base.map((c) => c.h));
    const lo = Math.min(...base.map((c) => c.l));
    const widthPct = (hi - lo) / hi;
    if (widthPct > 0.005) return undefined;
    if (last.c <= hi || before.c > hi) return undefined;
    const avgVol = sma(base.map((c) => c.v), base.length) ?? 0;
    if (avgVol > 0 && last.v < avgVol * 1.5) return undefined;
    const vw = vwap(today);
    if (vw !== undefined && q.ltp < vw) return undefined;
    const volRatio = avgVol > 0 ? last.v / avgVol : 1;
    return {
      pattern: this.id,
      reason: `Rested in a ${(widthPct * 100).toFixed(2)}% range for 12 min, then closed above ${hi.toFixed(2)} on volume ${volRatio.toFixed(1)}x`,
      stopPct: clamp((last.c - lo) / last.c + 0.0005, 0.004, 0.007),
      score: 60 + Math.min(25, Math.round(volRatio * 5)),
    };
  },
};

export const PATTERNS: Pattern[] = [openingRangeBreakout, vwapPullback, tightRangeBreakout, emaCross, momentumBreakout];

function sameDay(a: number, b: number): boolean {
  const off = 5.5 * 3600_000;
  return Math.floor((a + off) / 86_400_000) === Math.floor((b + off) / 86_400_000);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

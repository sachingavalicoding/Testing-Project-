import type { Candle, Quote } from '../types.ts';
import { istDate, istMinutes, MARKET_OPEN } from '../market/time.ts';
import { adx, atr, ema, macd, rsi, vwap } from './indicators.ts';
import type { Signal } from './patterns.ts';

/** Extra checks a signal must pass before we buy. Off by default so plain pattern tests stay simple. */
export interface QualityRules {
  enabled: boolean;
  /** Profit target for every auto entry, % above the buy price (0 = no target, only the stop ladder) */
  targetPct: number;
  /** Widest stop loss allowed, % below the buy price (0 = no limit besides reward-to-risk) */
  stopLossPct: number;
  /** Target must be at least this many times the stop distance */
  minRewardRisk: number;
  /** Skip all entries when the median share in the list is down more than this % today (market is weak) */
  breadthMin: number;
  /** Minutes after the open before the first entry (the first minutes are jumpy) */
  firstEntryMin: number;
  /** IST minutes since midnight: no new entries after this (too little time left) */
  lastEntryMinutes: number;
  /** Pattern score needed (0 = off) */
  minScore: number;
  /** Signal candle volume vs the average of the 20 before it (0 = off) */
  minVolumeRatio: number;
  /** Stops tighter than this % are noise (0 = off) */
  minStopPct: number;
  /** Most % above EMA9 (below for a short) when buying (0 = off) */
  maxStretchPct: number;
  /** Last closed candle must close in the top (bottom) part of its range: 0.6 = top 40% (0 = off) */
  candleStrength: number;
  /** Room to today's high (low) must be at least this many times target 1 (0 = off) */
  roomToTarget: number;
  /** 1 = EMA21 must rise (fall) over the last 5 candles */
  trendSlope: number;
  /** Target 1 as a multiple of the risk, used for the room check (0 = no staged targets) */
  t1: number;
  /** ADX (trend strength) must be at least this: below it the share is just chopping sideways (0 = off) */
  minAdx: number;
  /** 1 = the MACD histogram must agree with the trade and be moving the right way (0 = off) */
  macdConfirm: number;
  /** 1 = price must be on the right side of EMA50, the slower trend (0 = off) */
  slowTrend: number;
  /** Every stop is at least this many ATRs wide, so a normal candle cannot knock it out (0 = off) */
  atrStopMult: number;
}

export const defaultQuality: QualityRules = {
  enabled: false,
  targetPct: 0,
  stopLossPct: 0,
  minRewardRisk: 1.5,
  breadthMin: -0.3,
  firstEntryMin: 10,
  lastEntryMinutes: 14 * 60 + 30,
  minScore: 0,
  minVolumeRatio: 0,
  minStopPct: 0,
  maxStretchPct: 0,
  candleStrength: 0,
  roomToTarget: 0,
  trendSlope: 0,
  t1: 0,
  minAdx: 0,
  macdConfirm: 0,
  slowTrend: 0,
  atrStopMult: 0,
};

/** Biggest stop distance (fraction) that still gives the wanted reward-to-risk for the target. */
export function maxStopFraction(r: QualityRules): number {
  const byReward = r.targetPct > 0 ? r.targetPct / r.minRewardRisk / 100 : Infinity;
  const byLimit = r.stopLossPct > 0 ? r.stopLossPct / 100 : Infinity;
  return Math.min(byReward, byLimit);
}

/** The share's normal one-candle move (ATR of the last closed 1-minute candles) as a fraction of the price, or undefined. */
export function atrFraction(candles: Candle[], now: number, price: number): number | undefined {
  const current = Math.floor(now / 60_000) * 60_000;
  const done = candles.filter((c) => c.t < current).slice(-60);
  const a = atr(done, 14);
  return a !== undefined && price > 0 ? a / price : undefined;
}

/** Median day change % of the list. A weak market makes long entries fail more often. */
export function marketBreadthPct(quotes: Quote[]): number | undefined {
  const ch = quotes.filter((q) => q.prevClose > 0).map((q) => ((q.ltp - q.prevClose) / q.prevClose) * 100).sort((a, b) => a - b);
  return ch.length >= 20 ? ch[Math.floor(ch.length / 2)] : undefined;
}

/** Plain-words list of the checks a bought signal passed, saved with the trade ('why we took it'). */
export function qualitySummary(q: Quote, candles: Candle[], r: QualityRules, s: Signal): string {
  const parts: string[] = [`score ${s.score}`, `stop ${(s.stopPct * 100).toFixed(2)}%`];
  if (r.targetPct > 0) parts.push(`target ${r.targetPct}% (${(r.targetPct / (s.stopPct * 100)).toFixed(1)}x the stop)`);
  const day = istDate(q.ts);
  const current = Math.floor(q.ts / 60_000) * 60_000;
  const done = candles.filter((c) => c.t < current);
  const v = vwap(done.filter((c) => istDate(c.t) === day));
  const short = s.side === 'short';
  if (v !== undefined) parts.push(short ? `${(((v - q.ltp) / v) * 100).toFixed(2)}% below VWAP ${v.toFixed(2)}` : `${(((q.ltp - v) / v) * 100).toFixed(2)}% above VWAP ${v.toFixed(2)}`);
  if (done.length >= 22) {
    const closes = done.map((c) => c.c);
    const n = closes.length - 1;
    parts.push(`EMA9 ${ema(closes, 9)[n].toFixed(2)} ${short ? 'below' : 'above'} EMA21 ${ema(closes, 21)[n].toFixed(2)}`);
    const strength = rsi(closes, 14);
    if (strength !== undefined) parts.push(`RSI ${strength.toFixed(0)}`);
    const trend = adx(done.slice(-80), 14);
    if (trend !== undefined) parts.push(`ADX ${trend.toFixed(0)}`);
    const m = macd(closes);
    if (m) parts.push(`MACD ${m.hist >= 0 ? '+' : ''}${m.hist.toFixed(3)}`);
  }
  return parts.join(', ');
}

/**
 * Reason the whole market is wrong for this direction, or undefined. Longs sit out a weak market (median share down
 * more than the limit); shorts sit out a strong one (median share up more than the limit).
 */
export function marketBlocksSide(side: 'long' | 'short', breadth: number | undefined, r: QualityRules): string | undefined {
  if (breadth === undefined) return undefined;
  if (side === 'long' && breadth < r.breadthMin) return `market is weak (median share ${breadth.toFixed(2)}% today, limit ${r.breadthMin}%)`;
  if (side === 'short' && breadth > -r.breadthMin) return `market is strong (median share +${breadth.toFixed(2)}% today, shorts need it below +${(-r.breadthMin).toFixed(2)}%)`;
  return undefined;
}

/** Returns a plain-words reason to SKIP this signal, or undefined when it looks like a good entry. */
export function qualityReject(q: Quote, candles: Candle[], s: Signal, r: QualityRules): string | undefined {
  if (!r.enabled) return undefined;
  const short = s.side === 'short';
  const mins = istMinutes(q.ts);
  if (mins < MARKET_OPEN + r.firstEntryMin) return `first ${r.firstEntryMin} minutes are too jumpy`;
  if (mins > r.lastEntryMinutes) return 'too late in the day for a new entry';

  if (r.minScore > 0 && s.score < r.minScore) return `score ${s.score} is below the minimum ${r.minScore}`;
  if (r.minStopPct > 0 && s.stopPct * 100 < r.minStopPct) return `stop ${(s.stopPct * 100).toFixed(2)}% is tighter than ${r.minStopPct}% (normal price noise would hit it)`;

  const maxStop = maxStopFraction(r);
  if (s.stopPct > maxStop + 1e-9) {
    return `stop ${(s.stopPct * 100).toFixed(2)}% is wider than allowed (${(maxStop * 100).toFixed(2)}%${r.targetPct > 0 ? ` for a ${r.targetPct}% target, reward at least ${r.minRewardRisk}x risk` : ': widest stop setting'})`;
  }

  const day = istDate(q.ts);
  const current = Math.floor(q.ts / 60_000) * 60_000;
  const done = candles.filter((c) => c.t < current);
  const today = done.filter((c) => istDate(c.t) === day);
  const v = vwap(today);
  if (v !== undefined) {
    if (short) {
      if (q.ltp > v) return "price is above today's average price (VWAP): not a short";
      if (q.ltp < v * 0.988) return 'price is stretched more than 1.2% below VWAP (chasing the fall)';
    } else {
      if (q.ltp < v) return "price is below today's average price (VWAP)";
      if (q.ltp > v * 1.012) return 'price is stretched more than 1.2% above VWAP (chasing)';
    }
  }

  if (done.length >= 22) {
    const closes = done.map((c) => c.c);
    const n = closes.length - 1;
    const e9 = ema(closes, 9)[n];
    const e21s = ema(closes, 21);
    const e21 = e21s[n];
    if (r.trendSlope > 0 && n >= 5) {
      const rising = e21 > e21s[n - 5];
      if (!short && !rising) return 'EMA21 is not rising: the trend is flat or turning down';
      if (short && rising) return 'EMA21 is not falling: the trend is flat or turning up';
    }
    if (r.maxStretchPct > 0) {
      const stretch = ((q.ltp - e9) / e9) * 100;
      if (!short && stretch > r.maxStretchPct) return `price is ${stretch.toFixed(2)}% above EMA9 (chasing, limit ${r.maxStretchPct}%)`;
      if (short && -stretch > r.maxStretchPct) return `price is ${(-stretch).toFixed(2)}% below EMA9 (chasing the fall, limit ${r.maxStretchPct}%)`;
    }
    if (r.minVolumeRatio > 0 && done.length >= 21) {
      const last = done[done.length - 1];
      const prior = done.slice(-21, -1);
      const avg = prior.reduce((a, c) => a + c.v, 0) / prior.length;
      if (avg > 0 && last.v < avg * r.minVolumeRatio) return `volume ${(last.v / avg).toFixed(1)}x the recent average, needs ${r.minVolumeRatio}x`;
    }
    if (r.candleStrength > 0) {
      const last = done[done.length - 1];
      const range = last.h - last.l;
      if (range > 0) {
        const pos = (last.c - last.l) / range; // 1 = closed at the high
        if (!short && pos < r.candleStrength) return `signal candle closed weak (${Math.round(pos * 100)}% up its range, needs ${Math.round(r.candleStrength * 100)}%)`;
        if (short && 1 - pos < r.candleStrength) return `signal candle closed weak for a short (${Math.round((1 - pos) * 100)}% down its range, needs ${Math.round(r.candleStrength * 100)}%)`;
      }
    }
    if (r.roomToTarget > 0 && r.t1 > 0 && today.length > 0) {
      const room1 = q.ltp * s.stopPct * r.t1; // distance to target 1
      const dayHigh = Math.max(...today.map((c) => c.h));
      const dayLow = Math.min(...today.map((c) => c.l));
      if (!short && dayHigh > q.ltp && dayHigh - q.ltp < room1 * r.roomToTarget) return `today's high ${dayHigh} is too close to target 1 (no room to run)`;
      if (short && dayLow < q.ltp && q.ltp - dayLow < room1 * r.roomToTarget) return `today's low ${dayLow} is too close to target 1 (no room to run)`;
    }
    if (r.minAdx > 0) {
      const strong = adx(done.slice(-80), 14);
      if (strong !== undefined && strong < r.minAdx) return `trend is weak (ADX ${strong.toFixed(0)}, needs ${r.minAdx}): the share is chopping sideways`;
    }
    if (r.macdConfirm > 0) {
      const m = macd(closes);
      if (m) {
        if (!short && !(m.hist > 0 && m.hist >= m.prevHist)) return 'MACD does not agree: momentum is not building up';
        if (short && !(m.hist < 0 && m.hist <= m.prevHist)) return 'MACD does not agree: momentum is not building down';
      }
    }
    if (r.slowTrend > 0 && closes.length >= 55) {
      const e50 = ema(closes, 50)[n];
      if (!short && q.ltp < e50) return `price is under the slower trend (EMA50 ${e50.toFixed(2)})`;
      if (short && q.ltp > e50) return `price is over the slower trend (EMA50 ${e50.toFixed(2)})`;
    }
    const strength = rsi(closes, 14);
    if (short) {
      if (!(e9 < e21)) return 'short-term trend is not down (EMA9 above EMA21)';
      if (strength !== undefined) {
        if (strength > 50) return `momentum is not weak (RSI ${strength.toFixed(0)})`;
        if (strength < 24) return `already oversold (RSI ${strength.toFixed(0)})`;
      }
    } else {
      if (!(e9 > e21)) return 'short-term trend is not up (EMA9 below EMA21)';
      if (strength !== undefined) {
        if (strength < 50) return `momentum is weak (RSI ${strength.toFixed(0)})`;
        if (strength > 76) return `already overbought (RSI ${strength.toFixed(0)})`;
      }
    }
  }
  return undefined;
}

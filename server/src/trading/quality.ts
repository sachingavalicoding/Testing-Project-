import type { Candle, Quote } from '../types.ts';
import { istDate, istMinutes, MARKET_OPEN } from '../market/time.ts';
import { ema, rsi, vwap } from './indicators.ts';
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
}

export const defaultQuality: QualityRules = {
  enabled: false,
  targetPct: 0,
  stopLossPct: 0,
  minRewardRisk: 1.5,
  breadthMin: -0.3,
  firstEntryMin: 10,
  lastEntryMinutes: 14 * 60 + 30,
};

/** Biggest stop distance (fraction) that still gives the wanted reward-to-risk for the target. */
export function maxStopFraction(r: QualityRules): number {
  const byReward = r.targetPct > 0 ? r.targetPct / r.minRewardRisk / 100 : Infinity;
  const byLimit = r.stopLossPct > 0 ? r.stopLossPct / 100 : Infinity;
  return Math.min(byReward, byLimit);
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

  const maxStop = maxStopFraction(r);
  if (s.stopPct > maxStop + 1e-9) {
    return `stop ${(s.stopPct * 100).toFixed(2)}% is wider than allowed (${(maxStop * 100).toFixed(2)}% for a ${r.targetPct}% target, reward at least ${r.minRewardRisk}x risk)`;
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
    const e21 = ema(closes, 21)[n];
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

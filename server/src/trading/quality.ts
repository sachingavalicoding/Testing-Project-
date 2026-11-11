import type { Candle, Quote } from '../types.ts';
import { istDate, istMinutes, MARKET_OPEN } from '../market/time.ts';
import { ema, rsi, vwap } from './indicators.ts';
import type { Signal } from './patterns.ts';

/** Extra checks a signal must pass before we buy. Off by default so plain pattern tests stay simple. */
export interface QualityRules {
  enabled: boolean;
  /** Profit target for every auto entry, % above the buy price (0 = no target, only the stop ladder) */
  targetPct: number;
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
  minRewardRisk: 1.5,
  breadthMin: -0.3,
  firstEntryMin: 10,
  lastEntryMinutes: 14 * 60 + 30,
};

/** Biggest stop distance (fraction) that still gives the wanted reward-to-risk for the target. */
export function maxStopFraction(r: QualityRules): number {
  return r.targetPct > 0 ? r.targetPct / r.minRewardRisk / 100 : Infinity;
}

/** Median day change % of the list. A weak market makes long entries fail more often. */
export function marketBreadthPct(quotes: Quote[]): number | undefined {
  const ch = quotes.filter((q) => q.prevClose > 0).map((q) => ((q.ltp - q.prevClose) / q.prevClose) * 100).sort((a, b) => a - b);
  return ch.length >= 20 ? ch[Math.floor(ch.length / 2)] : undefined;
}

/** Returns a plain-words reason to SKIP this signal, or undefined when it looks like a good entry. */
export function qualityReject(q: Quote, candles: Candle[], s: Signal, r: QualityRules): string | undefined {
  if (!r.enabled) return undefined;
  const mins = istMinutes(q.ts);
  if (mins < MARKET_OPEN + r.firstEntryMin) return `first ${r.firstEntryMin} minutes are too jumpy`;
  if (mins > r.lastEntryMinutes) return 'too late in the day for a new entry';

  const maxStop = maxStopFraction(r);
  if (s.stopPct > maxStop + 1e-9) {
    return `stop ${(s.stopPct * 100).toFixed(2)}% is too wide for a ${r.targetPct}% target (need reward at least ${r.minRewardRisk}x risk)`;
  }

  const day = istDate(q.ts);
  const current = Math.floor(q.ts / 60_000) * 60_000;
  const done = candles.filter((c) => c.t < current);
  const today = done.filter((c) => istDate(c.t) === day);
  const v = vwap(today);
  if (v !== undefined) {
    if (q.ltp < v) return "price is below today's average price (VWAP)";
    if (q.ltp > v * 1.012) return 'price is stretched more than 1.2% above VWAP (chasing)';
  }

  if (done.length >= 22) {
    const closes = done.map((c) => c.c);
    const n = closes.length - 1;
    if (!(ema(closes, 9)[n] > ema(closes, 21)[n])) return 'short-term trend is not up (EMA9 below EMA21)';
    const strength = rsi(closes, 14);
    if (strength !== undefined) {
      if (strength < 50) return `momentum is weak (RSI ${strength.toFixed(0)})`;
      if (strength > 76) return `already overbought (RSI ${strength.toFixed(0)})`;
    }
  }
  return undefined;
}

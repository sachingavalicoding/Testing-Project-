import type { Candle, Quote } from '../types.ts';
import { netPnl } from '../trading/charges.ts';
import { vwap } from '../trading/indicators.ts';
import { roundToTick, TICK } from '../trading/ticks.ts';
import type { ScannerSettings, TradePlan } from './types.ts';
import { atr5, closedToday, round2 } from './util.ts';

/** How far above the current price an entry is still fine (the entry zone), in %. */
export const ENTRY_ZONE_PCT = 0.15;

/**
 * A full plan for a long trade: entry zone, stop, two targets, size from your risk amount (charges included).
 *  - Stop: the low of the last 10 candles when it sits between 1 and `atrStopMult` times the 5-minute ATR below
 *    the entry; closer than 1 ATR it is pushed out to 1 ATR (noise would hit it), farther than `atrStopMult` ATR
 *    it is pulled in to that. It is never closer than `minStopPct` and the plan is dropped if it must be wider
 *    than `maxStopPct`.
 *  - Target 1 is 1R and target 2 is 2R, where R is the distance from the entry to the stop.
 * Returns the reason in words when no plan can be made.
 */
export function buildPlan(q: Quote, candles: Candle[], s: ScannerSettings): { plan: TradePlan } | { reason: string } {
  const done = closedToday(candles, q.ts);
  const a = atr5(done);
  if (a === undefined || a <= 0) return { reason: 'not enough candles yet to measure the stop (ATR)' };

  const entryLow = roundToTick(q.ltp);
  const entryHigh = roundToTick(q.ltp * (1 + ENTRY_ZONE_PCT / 100), 'down');
  const entry = Math.max(entryHigh, entryLow); // plan for the worst fill inside the zone

  const swingLow = Math.min(...done.slice(-10).map((c) => c.l)) - TICK;
  const swingDist = entry - swingLow;
  const atrLo = a;
  const atrHi = Math.max(a, s.atrStopMult * a);
  let dist: number;
  let how: string;
  if (swingDist >= atrLo && swingDist <= atrHi) {
    dist = swingDist;
    how = `just under the last 10 candles' low ${swingLow.toFixed(2)}`;
  } else if (swingDist < atrLo) {
    dist = atrLo;
    how = `1 ATR (${a.toFixed(2)}) below entry: the recent low is too close to survive normal noise`;
  } else {
    dist = atrHi;
    how = `${s.atrStopMult} ATR (${a.toFixed(2)}) below entry: the recent low is too far away`;
  }
  const minDist = (entry * s.minStopPct) / 100;
  if (dist < minDist) {
    dist = minDist;
    how += `; widened to the ${s.minStopPct}% minimum`;
  }
  const stop = roundToTick(entry - dist, 'down');
  const stopPct = ((entry - stop) / entry) * 100;
  if (stopPct > s.maxStopPct) return { reason: `the stop would need to be ${stopPct.toFixed(2)}% away (your limit is ${s.maxStopPct}%)` };

  const r = entry - stop;
  const target1 = roundToTick(entry + r, 'up');
  const target2 = roundToTick(entry + 2 * r, 'up');

  let qty = Math.floor(s.riskPerTrade / r);
  while (qty > 0 && -netPnl(entry, stop, qty) > s.riskPerTrade) qty--;
  if (qty < 1) return { reason: `your risk amount ₹${s.riskPerTrade} is too small for even one share with this stop` };

  const v = vwap(done);
  const invalidIf = [
    `Price falls to ${stop.toFixed(2)} (the stop): the idea is wrong, exit`,
    `Price runs above ${entryHigh.toFixed(2)} before you are filled: do not chase`,
    ...(v !== undefined ? [`A 1-minute candle closes below VWAP ${v.toFixed(2)} after you enter`] : []),
    'Volume dries up and price stops making higher highs',
    'The market turns weak (most shares turn red)',
  ];

  return {
    plan: {
      side: 'BUY',
      entryLow,
      entryHigh,
      stop,
      stopPct: round2(stopPct),
      stopHow: how,
      target1,
      target2,
      rr1: round2((target1 - entry) / r),
      rr2: round2((target2 - entry) / r),
      qty,
      positionValue: Math.round(qty * entry),
      riskAfterCharges: round2(-netPnl(entry, stop, qty)),
      gain1AfterCharges: round2(netPnl(entry, target1, qty)),
      gain2AfterCharges: round2(netPnl(entry, target2, qty)),
      atr: round2(a),
      invalidIf,
    },
  };
}

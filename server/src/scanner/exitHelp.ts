import type { Candle, Quote } from '../types.ts';
import { istMinutes, parseHHMM } from '../market/time.ts';
import { netPnl } from '../trading/charges.ts';
import { vwap } from '../trading/indicators.ts';
import { roundToTick, TICK } from '../trading/ticks.ts';
import type { ExitAlert, ScannerSettings } from './types.ts';
import { atr5, closedToday } from './util.ts';

export interface HeldPosition {
  symbol: string;
  entry: number;
  qty: number;
  /** The stop it started with. 1R is the distance from the entry to this */
  stop0?: number;
  /** The stop now */
  stop: number;
  highest: number;
}

/** Lowest price where selling is not a loss after all charges. */
export function costPrice(entry: number, qty: number): number {
  let p = roundToTick(entry, 'up');
  for (let i = 0; i < 2000 && netPnl(entry, p, qty) < 0; i++) p = roundToTick(p + TICK);
  return p;
}

/**
 * Advice for an open long position. Nothing here places an order; it tells you what the plan says to do:
 *  - at +1R: move the stop to cost and sell half; then trail the rest 1 ATR under the highest price
 *  - warnings: price lost VWAP, volume dried up, a reversal candle at the highs
 *  - a hard square-off warning before your square-off time
 */
export function exitAdvice(p: HeldPosition, q: Quote, candles: Candle[], s: ScannerSettings, squareOffTime: string): ExitAlert[] {
  const alerts: ExitAlert[] = [];
  const done = closedToday(candles, q.ts);
  const r = p.stop0 !== undefined && p.stop0 < p.entry ? p.entry - p.stop0 : p.stop < p.entry ? p.entry - p.stop : undefined;
  const cost = costPrice(p.entry, p.qty);

  if (r !== undefined) {
    const gainR = (q.ltp - p.entry) / r;
    if (gainR >= 1) {
      if (p.stop < cost) alerts.push({ level: 'act', code: 'stop-to-cost', text: `Reached 1R (+${gainR.toFixed(1)}R): move your stop to cost ₹${cost.toFixed(2)} so this cannot turn into a loss` });
      alerts.push({ level: 'act', code: 'sell-half', text: `Target 1 (1R, ₹${(p.entry + r).toFixed(2)}) is reached: sell half now and let the rest run with a trailing stop` });
      const a = atr5(done);
      if (a !== undefined) {
        const trail = roundToTick(Math.max(cost, p.highest - a), 'down');
        if (trail > p.stop) alerts.push({ level: 'info', code: 'trail', text: `Trail the rest: stop at ₹${trail.toFixed(2)} (1 ATR under the high of ₹${p.highest.toFixed(2)})` });
      }
    }
  }

  const v = vwap(done);
  const last = done[done.length - 1];
  const before = done[done.length - 2];
  if (v !== undefined && last && last.c < v && q.ltp < v) {
    alerts.push({ level: 'warn', code: 'vwap-break', text: `Price is below VWAP ₹${v.toFixed(2)}: buyers lost control, consider exiting` });
  }
  if (done.length >= 15) {
    const avg = done.reduce((x, c) => x + c.v, 0) / done.length;
    const lastThree = done.slice(-3).reduce((x, c) => x + c.v, 0) / 3;
    if (avg > 0 && lastThree < avg * 0.5) {
      alerts.push({ level: 'warn', code: 'volume-dry', text: `Volume has dried up (last 3 minutes at ${Math.round((lastThree / avg) * 100)}% of the day's average): the move may be fading` });
    }
  }
  if (last && before && last.c < last.o) {
    const body = last.o - last.c;
    const upperWick = last.h - last.o;
    const engulf = last.o >= before.c && last.c <= before.o && before.c > before.o;
    const star = body > 0 && upperWick >= 2 * body && last.h >= p.highest * 0.998;
    if (engulf || star) {
      alerts.push({ level: 'warn', code: 'reversal', text: engulf ? 'A bearish engulfing candle just formed: sellers took over' : 'A shooting-star candle at the highs: price was rejected' });
    }
  }

  const left = parseHHMM(squareOffTime) - istMinutes(q.ts);
  if (left <= s.squareOffWarnMin && left > -5) {
    alerts.push({
      level: 'act',
      code: 'square-off',
      text: left > 0 ? `Square-off at ${squareOffTime}: ${left} minute${left === 1 ? '' : 's'} left. Close this intraday position before the broker does it for you` : `Square-off time ${squareOffTime} has passed: close this position now`,
    });
  }
  return alerts;
}

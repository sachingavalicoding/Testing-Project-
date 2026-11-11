import type { Candle } from '../types.ts';
import { istDate } from '../market/time.ts';

const IST_OFFSET_MS = 5.5 * 3600_000;

/** Today's completed 1-minute candles (the minute still forming is left out). */
export function closedToday(candles: Candle[], now: number): Candle[] {
  const current = Math.floor(now / 60_000) * 60_000;
  const day = istDate(now);
  return candles.filter((c) => c.t < current && istDate(c.t) === day);
}

/** Group 1-minute candles into `minutes`-minute candles lined up with the NSE clock (09:15, 09:30, ...). */
export function aggregate(candles: Candle[], minutes: number): Candle[] {
  const size = minutes * 60_000;
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor((c.t + IST_OFFSET_MS) / size) * size - IST_OFFSET_MS;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else {
      out.push({ t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    }
  }
  return out;
}

/** Average true range (Wilder). Needs at least `period + 1` candles. */
export function atr(candles: Candle[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;
  const tr = (i: number) => Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  for (let i = period + 1; i < candles.length; i++) a = (a * (period - 1) + tr(i)) / period;
  return a;
}

/**
 * ATR on a 5-minute chart (a stop of 1 to 1.5 of these sits outside normal 1-minute noise).
 * With less than half an hour of data it falls back to the 1-minute ATR scaled up.
 */
export function atr5(done: Candle[]): number | undefined {
  const five = aggregate(done, 5);
  if (five.length >= 7) return atr(five, Math.min(14, five.length - 1));
  const one = atr(done, 14);
  return one === undefined ? undefined : one * Math.sqrt(5);
}

/** MACD histogram now and one candle ago (12, 26, 9). */
export function macdHist(closes: number[]): { hist: number; prev: number } | undefined {
  if (closes.length < 35) return undefined;
  const ema = (vals: number[], p: number) => {
    const k = 2 / (p + 1);
    const o = [vals[0]];
    for (let i = 1; i < vals.length; i++) o.push(vals[i] * k + o[i - 1] * (1 - k));
    return o;
  };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(line, 9);
  const n = closes.length - 1;
  return { hist: line[n] - signal[n], prev: line[n - 1] - signal[n - 1] };
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const round2 = (n: number) => Math.round(n * 100) / 100;

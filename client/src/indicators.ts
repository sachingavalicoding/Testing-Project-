import type { Candle } from './api.ts';

export function aggregate(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const size = minutes * 60_000;
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else out.push({ ...c, t });
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

const IST = 5.5 * 3600_000;
const dayKey = (t: number) => Math.floor((t + IST) / 86_400_000);

/** Volume-weighted average price, restarting each day. Undefined where there is no volume yet. */
export function vwapSeries(candles: Candle[]): Array<number | undefined> {
  let day = -1, pv = 0, vol = 0;
  return candles.map((c) => {
    const d = dayKey(c.t);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vol += c.v;
    return vol > 0 ? pv / vol : undefined;
  });
}

import { rng } from '../src/lab/optimize.ts';
import type { DayData } from '../src/lab/replay.ts';
import type { Candle } from '../src/types.ts';

/** A made-up but realistic day: a market-wide drift plus each share's own wandering, with volume bursts. */
export function syntheticDay(day: string, seed: number, symbols = 40, drift = 0): DayData {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const [y, m, d] = day.split('-').map(Number);
  const open = Date.UTC(y, m - 1, d, 3, 45); // 09:15 IST
  const map: DayData['symbols'] = new Map();
  const market: number[] = [];
  let mk = 0;
  for (let i = 0; i < 375; i++) { mk += drift / 375 + gauss() * 0.0004; market.push(mk); }
  for (let s = 0; s < symbols; s++) {
    const prev = 100 + rand() * 2000;
    let p = prev * (1 + gauss() * 0.003);
    const candles: Candle[] = [];
    let trend = gauss() * 0.0002;
    for (let i = 0; i < 375; i++) {
      if (i % 40 === 0) trend = gauss() * 0.0003;
      const o = p;
      const c = o * (1 + trend + (market[i] - (market[i - 1] ?? 0)) + gauss() * 0.0009);
      const h = Math.max(o, c) * (1 + rand() * 0.0006);
      const l = Math.min(o, c) * (1 - rand() * 0.0006);
      const burst = rand() < 0.08 ? 3 + rand() * 6 : 1;
      candles.push({ t: open + i * 60_000, o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), v: Math.round((800 + rand() * 600) * burst) });
      p = c;
    }
    map.set(`SYM${s}`, { prevClose: +prev.toFixed(2), candles });
  }
  return { day, symbols: map };
}

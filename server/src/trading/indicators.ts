export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** Volume weighted average price of the candles (today's candles only should be passed). */
export function vwap(candles: Array<{ h: number; l: number; c: number; v: number }>): number | undefined {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    pv += ((c.h + c.l + c.c) / 3) * c.v;
    vol += c.v;
  }
  return vol > 0 ? pv / vol : undefined;
}

/** Relative strength index (Wilder). Returns undefined until there are `period + 1` values. */
export function rsi(values: number[], period = 14): number | undefined {
  if (values.length < period + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

type Bar = { h: number; l: number; c: number };

/** Average true range (Wilder) in price units: how far a share normally moves in one candle. */
export function atr(candles: Bar[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;
  const tr = (i: number) => Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  for (let i = period + 1; i < candles.length; i++) a = (a * (period - 1) + tr(i)) / period;
  return a;
}

/** MACD (12/26/9). `hist` is the MACD line minus its signal line; `prevHist` is the same one candle earlier. */
export function macd(values: number[], fast = 12, slow = 26, signal = 9): { hist: number; prevHist: number } | undefined {
  if (values.length < slow + signal) return undefined;
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);
  const sig = ema(line, signal);
  const n = values.length - 1;
  return { hist: line[n] - sig[n], prevHist: line[n - 1] - sig[n - 1] };
}

/** Average directional index (Wilder): how strong the trend is, 0-100, in either direction. 20+ is a real trend, under 15 is chop. */
export function adx(candles: Array<{ h: number; l: number; c: number }>, period = 14): number | undefined {
  if (candles.length < period * 2 + 1) return undefined;
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  const dxs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.h - p.h;
    const down = p.l - c.l;
    const t = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    const pm = up > down && up > 0 ? up : 0;
    const mm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      tr += t; pdm += pm; mdm += mm;
    } else {
      tr = tr - tr / period + t;
      pdm = pdm - pdm / period + pm;
      mdm = mdm - mdm / period + mm;
    }
    if (i >= period && tr > 0) {
      const pdi = (100 * pdm) / tr;
      const mdi = (100 * mdm) / tr;
      dxs.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi));
    }
  }
  if (dxs.length < period) return undefined;
  let a = dxs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dxs.length; i++) a = (a * (period - 1) + dxs[i]) / period;
  return a;
}

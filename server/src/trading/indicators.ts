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

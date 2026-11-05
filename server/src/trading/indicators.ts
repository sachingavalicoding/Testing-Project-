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

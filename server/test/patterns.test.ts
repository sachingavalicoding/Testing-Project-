import { describe, expect, it } from 'vitest';
import { momentumBreakout } from '../src/trading/patterns.ts';
import type { Candle, Quote } from '../src/types.ts';

// 10:45 IST on a weekday = 05:15 UTC
const now = Date.UTC(2026, 10, 5, 5, 15, 30);
const minute = Math.floor(now / 60_000) * 60_000;

function candles(lastClose: number, lastVol: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 30; i >= 1; i--) out.push({ t: minute - i * 60_000, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000 });
  const last = out[out.length - 1];
  last.c = lastClose;
  last.h = Math.max(lastClose, last.h);
  last.v = lastVol;
  return out;
}

const quote = (ltp: number, prevClose = 100): Quote => ({ symbol: 'X', ltp, prevClose, open: prevClose, high: ltp, low: prevClose, volume: 0, ts: now });

describe('momentumBreakout', () => {
  it('fires on a fresh breakout with a volume surge when up 2%+', () => {
    const s = momentumBreakout.check(quote(103.5), candles(103, 5000));
    expect(s?.pattern).toBe('mom');
    expect(s!.stopPct).toBeGreaterThanOrEqual(0.01);
    expect(s!.stopPct).toBeLessThanOrEqual(0.03);
  });

  it('ignores a breakout on thin volume', () => {
    expect(momentumBreakout.check(quote(103.5), candles(103, 1100))).toBeUndefined();
  });

  it('ignores shares up less than 2% on the day', () => {
    expect(momentumBreakout.check(quote(101.5), candles(101, 5000))).toBeUndefined();
  });

  it('ignores a break that was already running', () => {
    const cs = candles(104, 5000);
    cs[cs.length - 2].c = 103;
    expect(momentumBreakout.check(quote(104.5), cs)).toBeUndefined();
  });
});

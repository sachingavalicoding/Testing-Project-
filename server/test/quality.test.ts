import { describe, expect, it } from 'vitest';
import { rsi } from '../src/trading/indicators.ts';
import { tightRangeBreakout, vwapPullback } from '../src/trading/patterns.ts';
import { defaultQuality, marketBreadthPct, maxStopFraction, qualityReject } from '../src/trading/quality.ts';
import type { Candle, Quote } from '../src/types.ts';

// 11:00 IST on a weekday = 05:30 UTC
const now = Date.UTC(2026, 10, 5, 5, 30, 30);
const minute = Math.floor(now / 60_000) * 60_000;

/** One candle per close, oldest first, the last one finishing a minute before `now`. */
function build(closes: number[], vol: (i: number) => number = () => 1000): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return { t: minute - (closes.length - i) * 60_000, o: prev, h: Math.max(prev, c) + 0.05, l: Math.min(prev, c) - 0.05, c, v: vol(i) };
  });
}

const quote = (ltp: number, prevClose = 100, ts = now): Quote => ({ symbol: 'X', ltp, prevClose, open: prevClose, high: ltp, low: prevClose, volume: 0, ts });
const rules = { ...defaultQuality, enabled: true, targetPct: 1 };

describe('rsi', () => {
  it('is 100 when price only rises and low when it only falls', () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i))).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i))!).toBeLessThan(5);
  });
  it('needs enough values', () => {
    expect(rsi([1, 2, 3])).toBeUndefined();
  });
});

describe('tightRangeBreakout', () => {
  const flat = Array.from({ length: 20 }, (_, i) => 100.8 + (i % 2 ? 0.05 : -0.05));
  it('fires when a quiet 12 minutes breaks up on volume', () => {
    const closes = [...flat, 101.3];
    const cs = build(closes, (i) => (i === closes.length - 1 ? 3000 : 1000));
    const s = tightRangeBreakout.check(quote(101.35), cs);
    expect(s?.pattern).toBe('squeeze');
    expect(s!.stopPct).toBeLessThanOrEqual(0.007);
  });
  it('ignores a break on thin volume', () => {
    const closes = [...flat, 101.3];
    expect(tightRangeBreakout.check(quote(101.35), build(closes))).toBeUndefined();
  });
  it('ignores a wide, noisy range', () => {
    const noisy = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 1.2 : -1.2));
    const closes = [...noisy, 103];
    expect(tightRangeBreakout.check(quote(103.1), build(closes, (i) => (i === closes.length - 1 ? 3000 : 1000)))).toBeUndefined();
  });
});

describe('vwapPullback', () => {
  // Rises to ~102, dips back near support, then a green candle closes back above EMA9.
  const path = [
    ...Array.from({ length: 28 }, (_, i) => 100 + i * 0.07),
    101.95, 101.75, 101.55, 101.4, 101.3, 101.45, 101.9,
  ];
  it('fires on a bounce from support in an uptrend', () => {
    const s = vwapPullback.check(quote(101.95), build(path));
    expect(s?.pattern).toBe('vwappb');
    expect(s!.stopPct).toBeGreaterThanOrEqual(0.003);
    expect(s!.stopPct).toBeLessThanOrEqual(0.01);
  });
  it('ignores a share that is falling on the day', () => {
    expect(vwapPullback.check(quote(98.5, 101), build(path))).toBeUndefined();
  });
});

describe('qualityReject', () => {
  // Zig-zag uptrend (a straight line up would have an RSI of 100, which is rightly rejected as overbought).
  const up = Array.from({ length: 30 }, (_, i) => 100 + i * 0.03 + (i % 2 ? -0.04 : 0.04));
  const sig = (stopPct: number) => ({ pattern: 't', reason: 'r', stopPct, score: 60 });

  it('does nothing when switched off', () => {
    expect(qualityReject(quote(101), build(up), sig(0.05), { ...rules, enabled: false })).toBeUndefined();
  });
  it('accepts a healthy trend with a tight stop', () => {
    expect(qualityReject(quote(100.95), build(up), sig(0.005), rules)).toBeUndefined();
  });
  it('rejects a stop that is too wide for the target', () => {
    expect(qualityReject(quote(100.95), build(up), sig(0.012), rules)).toMatch(/too wide/);
  });
  it('rejects the first minutes and late entries', () => {
    expect(qualityReject(quote(100.95, 100, Date.UTC(2026, 10, 5, 3, 50)), build(up), sig(0.005), rules)).toMatch(/jumpy/);
    expect(qualityReject(quote(100.95, 100, Date.UTC(2026, 10, 5, 9, 30)), build(up), sig(0.005), rules)).toMatch(/too late/);
  });
  it('rejects price below VWAP and price stretched far above it', () => {
    expect(qualityReject(quote(99), build(up), sig(0.005), rules)).toMatch(/below/);
    expect(qualityReject(quote(103), build(up), sig(0.005), rules)).toMatch(/stretched/);
  });
  it('rejects a downtrend', () => {
    const down = Array.from({ length: 30 }, (_, i) => 101 - i * 0.03);
    expect(qualityReject(quote(100.2), build(down), sig(0.005), rules)).toMatch(/below|trend is not up|momentum/);
  });
  it('rejects an overbought straight-line run', () => {
    const run = Array.from({ length: 30 }, (_, i) => 100 + i * 0.03);
    expect(qualityReject(quote(100.95), build(run), sig(0.005), rules)).toMatch(/overbought/);
  });
});

describe('helpers', () => {
  it('maxStopFraction follows target and reward-to-risk', () => {
    expect(maxStopFraction({ ...defaultQuality, targetPct: 1, minRewardRisk: 1.5 })).toBeCloseTo(0.00667, 4);
    expect(maxStopFraction(defaultQuality)).toBe(Infinity);
  });
  it('market breadth is the median day change', () => {
    const qs = Array.from({ length: 25 }, (_, i) => quote(100 + (i - 12) * 0.1));
    expect(marketBreadthPct(qs)).toBeCloseTo(0, 5);
    expect(marketBreadthPct(qs.slice(0, 5))).toBeUndefined();
  });
});

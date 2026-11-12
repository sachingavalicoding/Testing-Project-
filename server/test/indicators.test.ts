import { describe, expect, it } from 'vitest';
import { adx, atr, macd } from '../src/trading/indicators.ts';
import { defaultSettings, qualityFor, validateSettings } from '../src/settings.ts';
import { defaultQuality, qualityReject } from '../src/trading/quality.ts';
import type { Candle, Quote } from '../src/types.ts';

const bar = (c: number, w = 0.2) => ({ h: c + w, l: c - w, c });
const trend = (n: number, step: number) => Array.from({ length: n }, (_, i) => bar(100 + i * step));
const flat = (n: number) => Array.from({ length: n }, (_, i) => bar(100 + (i % 2 ? 0.1 : -0.1)));

describe('atr / adx / macd', () => {
  it('atr is the normal candle range', () => {
    expect(atr(Array.from({ length: 30 }, () => bar(100, 0.5)))!).toBeCloseTo(1, 5);
    expect(atr([bar(1)])).toBeUndefined();
  });
  it('adx is high in a clean trend (either way) and low when sideways', () => {
    expect(adx(trend(60, 0.3))!).toBeGreaterThan(40);
    expect(adx(trend(60, -0.3))!).toBeGreaterThan(40);
    expect(adx(flat(60))!).toBeLessThan(15);
    expect(adx(flat(10))).toBeUndefined();
  });
  it('macd histogram is positive when price accelerates up and negative when it falls', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.01);
    expect(macd(up)!.hist).toBeGreaterThan(0);
    expect(macd(up.map((v) => 200 - v))!.hist).toBeLessThan(0);
    expect(macd([1, 2, 3])).toBeUndefined();
  });
});

describe('new entry checks', () => {
  const now = Date.UTC(2026, 10, 5, 5, 30, 30); // 11:00 IST
  const minute = Math.floor(now / 60_000) * 60_000;
  const candles = (closes: number[]): Candle[] => closes.map((c, i) => ({ t: minute - (closes.length - i) * 60_000, o: c, h: c + 0.05, l: c - 0.05, c, v: 1000 }));
  const q = (ltp: number): Quote => ({ symbol: 'X', ltp, prevClose: 100, open: 100, high: ltp, low: 99, volume: 0, ts: now });
  const sig = { pattern: 'p', reason: '', stopPct: 0.006, score: 80 };
  const chop = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1));

  it('skips a sideways share when trend strength is required', () => {
    const r = { ...defaultQuality, enabled: true, minAdx: 18 };
    expect(qualityReject(q(100), candles(chop), sig, r)).toMatch(/ADX|weak|EMA/);
    const only = qualityReject(q(100), candles(chop), sig, { ...defaultQuality, enabled: true, minAdx: 18 });
    expect(only).toBeDefined();
  });
  it('slow trend: a short over EMA50 is skipped, one under it is not', () => {
    const r = { ...defaultQuality, enabled: true, slowTrend: 1 };
    const fell = Array.from({ length: 60 }, (_, i) => (i < 30 ? 100 : 99)); // VWAP 99.5, EMA50 99.30
    const short = { ...sig, side: 'short' as const };
    expect(qualityReject(q(99.4), candles(fell), short, r)).toMatch(/slower trend/);
    expect(qualityReject(q(99.2), candles(fell), short, r) ?? '').not.toMatch(/slower trend/);
    expect(qualityReject(q(99.4), candles(fell), short, { ...r, slowTrend: 0 }) ?? '').not.toMatch(/slower trend/);
  });
});

describe('per-list settings', () => {
  const d = defaultSettings({ money: { capital: 50000, riskPerTrade: 500, maxOpenPositions: 5, dailyLossCap: 2000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never);
  it('mid and small caps start stricter on volume and trend than large caps', () => {
    const l = qualityFor(d, 'large');
    const m = qualityFor(d, 'mid');
    const s = qualityFor(d, 'small');
    expect(m.minVolumeRatio).toBeGreaterThan(l.minVolumeRatio);
    expect(s.minVolumeRatio).toBeGreaterThan(m.minVolumeRatio);
    expect(s.atrStopMult).toBeGreaterThan(l.atrStopMult);
    expect(s.minAdx).toBeGreaterThan(l.minAdx);
  });
  it('older saved settings without per-list checks get this list\'s starting values', () => {
    const old = JSON.parse(JSON.stringify(d));
    for (const id of ['large', 'mid', 'small']) delete old.lists[id].checks;
    delete old.entryChecks.minAdx;
    const v = validateSettings(old);
    expect(v.lists.small.checks.minVolumeRatio).toBe(2);
    expect(v.entryChecks.macdConfirm).toBe(1);
  });
  it('rejects a silly value', () => {
    const bad = JSON.parse(JSON.stringify(d));
    bad.lists.mid.checks.minAdx = 99;
    expect(() => validateSettings(bad)).toThrow(/ADX/);
  });
});

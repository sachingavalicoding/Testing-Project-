import { describe, expect, it } from 'vitest';
import { netPnl, roundTripCharges } from '../src/trading/charges.ts';
import { positionSize } from '../src/trading/sizing.ts';
import { initialStop, ladderStop } from '../src/trading/stops.ts';
import { roundToTick } from '../src/trading/ticks.ts';

describe('charges', () => {
  it('caps brokerage at ₹20 per order', () => {
    const c = roundTripCharges(1000, 1000, 100); // ₹1L each side
    expect(c.brokerage).toBe(40);
  });

  it('uses 0.1% brokerage on small orders', () => {
    const c = roundTripCharges(100, 100, 10); // ₹1000 each side → ₹1 + ₹1
    expect(c.brokerage).toBe(2);
  });

  it('charges STT only on the sell side and stamp only on buy', () => {
    const c = roundTripCharges(1000, 1100, 100);
    expect(c.stt).toBe(Math.round(110000 * 0.00025));
    expect(c.stamp).toBe(Math.round(100000 * 0.00003));
  });

  it('flat trade is a small loss because of charges', () => {
    expect(netPnl(500, 500, 50)).toBeLessThan(0);
  });
});

describe('position size', () => {
  it('limits by risk', () => {
    // ₹200 risk, 1% stop on ₹1000 share = ₹10/share → 20 shares
    expect(positionSize({ price: 1000, freeCash: 30000, marginPerShare: 200, riskPerTrade: 200, stopPct: 0.01 })).toBe(20);
  });

  it('limits by real margin', () => {
    // 5x leverage → ₹200 per share, ₹3000 free → 15 shares
    expect(positionSize({ price: 1000, freeCash: 3000, marginPerShare: 200, riskPerTrade: 10000, stopPct: 0.01 })).toBe(15);
  });

  it('sizes from a fixed capital per trade, ignoring the risk cap', () => {
    expect(positionSize({ price: 1000, freeCash: 100000, marginPerShare: 200, riskPerTrade: 200, stopPct: 0.01, capitalPerTrade: 20000 })).toBe(100); // 20000 margin at 5x = 100 shares = 1 lakh
    expect(positionSize({ price: 1000, freeCash: 5000, marginPerShare: 200, riskPerTrade: 200, stopPct: 0.01, capitalPerTrade: 20000 })).toBe(25); // never more than the free cash
  });

  it('returns 0 for bad input', () => {
    expect(positionSize({ price: 0, freeCash: 3000, marginPerShare: 200, riskPerTrade: 200, stopPct: 0.01 })).toBe(0);
  });
});

describe('stops', () => {
  it('rounds to NSE tick', () => {
    expect(roundToTick(100.07, 'down')).toBe(100.05);
    expect(roundToTick(100.01, 'up')).toBe(100.05);
  });

  it('initial stop never allows more than the max loss incl. charges', () => {
    const entry = 1000;
    const qty = 40;
    const stop = initialStop(entry, qty, 0.01, 300);
    expect(-netPnl(entry, stop, qty)).toBeLessThanOrEqual(300);
    // and it is tighter than the plain 1% stop because 1% would lose ₹400+
    expect(stop).toBeGreaterThan(990);
  });

  it('keeps the plain % stop when it already fits the cap', () => {
    expect(initialStop(1000, 10, 0.01, 1000)).toBe(990);
  });

  it('ladder: no move before first step', () => {
    expect(ladderStop(1000, 20, 1004, 990, { stepPct: 0.5 })).toBe(990);
  });

  it('ladder: first step moves stop to break-even incl. charges', () => {
    const s = ladderStop(1000, 20, 1005, 990, { stepPct: 0.5 });
    expect(s).toBeGreaterThanOrEqual(1000);
    expect(netPnl(1000, s, 20)).toBeGreaterThanOrEqual(0);
  });

  it('ladder: later steps lock profit and never move down', () => {
    expect(ladderStop(1000, 20, 1015, 990, { stepPct: 0.5 })).toBe(1010);
    expect(ladderStop(1000, 20, 1006, 1010, { stepPct: 0.5 })).toBe(1010);
  });
});

import { advanceTargets, buildTargets } from '../src/trading/stops.ts';
describe('staged targets', () => {
  const plan = { t1: 1, t2: 1.5, t3: 2 };
  it('builds targets from the stop distance', () => {
    expect(buildTargets(1000, 990, 'long', plan)).toEqual([1010, 1015, 1020]);
    expect(buildTargets(1000, 1010, 'short', plan)).toEqual([990, 985, 980]);
  });
  it('long: target 1 -> break-even, target 2 -> target 1, target 3 -> done', () => {
    const t = [1010, 1015, 1020];
    expect(advanceTargets('long', 1000, 100, 1005, t, 0, 990)).toEqual({ stage: 0, stop: 990, done: false });
    const a = advanceTargets('long', 1000, 100, 1010, t, 0, 990);
    expect(a.stage).toBe(1);
    expect(a.stop).toBeGreaterThanOrEqual(1000);
    expect(netPnl(1000, a.stop, 100)).toBeGreaterThanOrEqual(0);
    const b = advanceTargets('long', 1000, 100, 1015, t, a.stage, a.stop);
    expect(b).toEqual({ stage: 2, stop: 1010, done: false });
    expect(advanceTargets('long', 1000, 100, 1020, t, b.stage, b.stop).done).toBe(true);
    expect(advanceTargets('long', 1000, 100, 1030, t, 0, 990).done).toBe(true); // gap straight to the last one
  });
  it('short: mirror', () => {
    const t = [990, 985, 980];
    const a = advanceTargets('short', 1000, 100, 990, t, 0, 1010);
    expect(a.stage).toBe(1);
    expect(netPnl(a.stop, 1000, 100)).toBeGreaterThanOrEqual(0);
    expect(advanceTargets('short', 1000, 100, 985, t, a.stage, a.stop)).toEqual({ stage: 2, stop: 990, done: false });
    expect(advanceTargets('short', 1000, 100, 979, t, 0, 1010).done).toBe(true);
  });
});

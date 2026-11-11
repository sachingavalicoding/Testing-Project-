import { describe, expect, it } from 'vitest';
import { MarketStore } from '../src/market/store.ts';
import { seedHistory } from '../src/market/seed.ts';
import type { Candle } from '../src/types.ts';
import { istDate } from '../src/market/time.ts';

const c = (t: number, p: number, v = 100): Candle => ({ t, o: p, h: p + 1, l: p - 1, c: p, v });
const minute = Math.floor(Date.now() / 60_000) * 60_000;

describe('MarketStore.seedCandles', () => {
  it('puts history in front of live candles and merges the same minute', () => {
    const s = new MarketStore();
    s.update([{ symbol: 'A', ltp: 105, prevClose: 100, open: 100, high: 105, low: 100, volume: 0, ts: minute + 5000 }]);
    s.seedCandles('A', [c(minute - 120_000, 100), c(minute - 60_000, 102), c(minute, 103, 500)]);
    const out = s.candlesFor('A');
    expect(out.map((x) => x.t)).toEqual([minute - 120_000, minute - 60_000, minute]);
    expect(out[2]).toMatchObject({ o: 103, c: 105, v: 500 }); // history open and volume, live close
    expect(out[2].h).toBe(Math.max(104, 105));
  });
});

describe('seedHistory', () => {
  const feed = (name: 'upstox' | 'mock') => ({
    name,
    getCandles: async (sym: string) => {
      if (sym === 'BAD') throw new Error('rate limited');
      return [c(minute - 60_000, 100), c(Date.now() - 3 * 86_400_000, 50)]; // second one is an old day
    },
  });

  it('loads only today\'s candles and survives a failing share', async () => {
    const store = new MarketStore();
    const logs: string[] = [];
    const n = await seedHistory(feed('upstox'), store, ['A', 'BAD', 'B'], { log: (m) => logs.push(m) });
    expect(n).toBe(2);
    expect(store.candlesFor('A')).toHaveLength(1);
    expect(istDate(store.candlesFor('A')[0].t)).toBe(istDate());
    expect(store.candlesFor('BAD')).toHaveLength(0);
    expect(logs[0]).toContain('2 of 3');
  });

  it('does nothing for the mock feed', async () => {
    expect(await seedHistory(feed('mock'), new MarketStore(), ['A'])).toBe(0);
  });

  it('stops when the share list was switched meanwhile', async () => {
    const store = new MarketStore();
    expect(await seedHistory(feed('upstox'), store, ['A', 'B'], { stillWanted: () => false })).toBe(0);
    expect(store.candlesFor('A')).toHaveLength(0);
  });
});

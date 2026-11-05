import { describe, expect, it } from 'vitest';
import { MarketStore } from '../src/market/store.ts';
import { MockFeed } from '../src/market/mockFeed.ts';
import { UpstoxClient } from '../src/broker/upstoxClient.ts';
import { UpstoxBroker } from '../src/broker/upstoxBroker.ts';
import { UNIVERSES } from '../src/universe/index.ts';

describe('universe', () => {
  it('each list has 100 unique symbols', () => {
    for (const u of Object.values(UNIVERSES)) expect(new Set(u.symbols).size, u.id).toBe(100);
  });

  it('lists do not overlap', () => {
    const all = Object.values(UNIVERSES).flatMap((u) => [...u.symbols]);
    expect(new Set(all).size).toBe(300);
  });
});

describe('MarketStore', () => {
  it('clear() forgets old shares', () => {
    const s = new MarketStore();
    s.update([{ symbol: 'A', ltp: 1, prevClose: 1, open: 1, high: 1, low: 1, volume: 0, ts: 0 }]);
    s.clear();
    expect(s.allQuotes()).toHaveLength(0);
    expect(s.candlesFor('A')).toHaveLength(0);
  });

  it('ranks gainers and losers', () => {
    const s = new MarketStore();
    const q = (symbol: string, ltp: number) => ({ symbol, ltp, prevClose: 100, open: 100, high: ltp, low: ltp, volume: 0, ts: 0 });
    s.update([q('A', 105), q('B', 98), q('C', 101), q('D', 90)]);
    const m = s.movers(10);
    expect(m.gainers.map((g) => g.symbol)).toEqual(['A', 'C']);
    expect(m.losers.map((g) => g.symbol)).toEqual(['D', 'B']);
    expect(m.gainers[0].changePct).toBe(5);
  });

  it('builds 1-minute candles from ticks', () => {
    const s = new MarketStore();
    const base = 1_700_000_040_000 - (1_700_000_040_000 % 60_000);
    const q = (ltp: number, ts: number, volume: number) => ({ symbol: 'X', ltp, prevClose: 100, open: 100, high: 0, low: 0, volume, ts });
    s.update([q(100, base, 1000)]);
    s.update([q(102, base + 10_000, 1500)]);
    s.update([q(99, base + 20_000, 1700)]);
    s.update([q(101, base + 60_000, 2000)]);
    const c = s.candlesFor('X');
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ o: 100, h: 102, l: 99, c: 99, v: 700 });
    expect(c[1]).toMatchObject({ o: 101, v: 300 });
  });
});

describe('MockFeed', () => {
  it('gives stable base prices and candles', async () => {
    const f = new MockFeed();
    expect(f.basePrice('INFY')).toBe(f.basePrice('INFY'));
    const c = await f.getCandles('INFY', 'day', 30);
    expect(c).toHaveLength(30);
  });
});

describe('UpstoxClient', () => {
  it('retries after a 429 and sends the bearer token', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    let n = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      n++;
      if (n === 1) return new Response('{}', { status: 429 });
      return new Response(JSON.stringify({ status: 'success', data: { required_margin: 200 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new UpstoxClient({ apiKey: 'k', apiSecret: 's', redirectUri: 'r', accessToken: 'TOKEN', minGapMs: 0 }, fakeFetch);
    c.setInstrumentKeys({ INFY: 'NSE_EQ|INE009A01021' });
    const m = await new UpstoxBroker(c).getMargin('INFY', 1, 1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].auth).toBe('Bearer TOKEN');
    expect(m.leverage).toBe(5);
    expect(m.marginPerShare).toBe(200);
  });

  it('builds the login URL from env values', () => {
    const c = new UpstoxClient({ apiKey: 'abc', apiSecret: 's', redirectUri: 'http://x/cb' });
    expect(c.loginUrl()).toContain('client_id=abc');
    expect(c.loginUrl()).toContain(encodeURIComponent('http://x/cb'));
  });
});

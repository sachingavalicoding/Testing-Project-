import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PaperBroker } from '../src/broker/paperBroker.ts';
import { Db } from '../src/db/db.ts';
import { MarketStore } from '../src/market/store.ts';
import { MockFeed } from '../src/market/mockFeed.ts';
import { defaultSettings } from '../src/settings.ts';
import { loadConfig } from '../src/config.ts';
import { AutoTrader } from '../src/trading/autoTrader.ts';
import type { Quote } from '../src/types.ts';

const rules = { capital: 30000, dailyLossCap: 500, maxOpenPositions: 3, riskPerTrade: 200, maxDayMovePct: 3, squareOffTime: '15:15' };
const quote = (symbol: string, ltp: number): Quote => ({ symbol, ltp, prevClose: ltp, open: ltp, high: ltp, low: ltp, volume: 0, ts: Date.now() });

describe('manual trading', () => {
  let db: Db;
  let store: MarketStore;
  let trader: AutoTrader;
  const push = async (...qs: Quote[]) => {
    store.update(qs);
    await trader.onQuotes(qs);
  };

  beforeEach(() => {
    db = new Db(':memory:');
    store = new MarketStore();
    trader = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5), realAllowed: false, patterns: [], ignoreMarketHours: true });
  });

  it('market buy works while auto trading is stopped, with a default 1% stop', async () => {
    await push(quote('INFY', 1000));
    const r = await trader.manualBuy({ symbol: 'INFY', qty: 10, type: 'market' });
    expect(r.status).toBe('filled');
    const p = trader.positions.get('INFY')!;
    expect(p.pattern).toBe('manual');
    expect(p.stop).toBe(990);
    expect(trader.running).toBe(false);
  });

  it('uses the stop price and target you give; target sells at profit', async () => {
    await push(quote('INFY', 1000));
    await trader.manualBuy({ symbol: 'INFY', qty: 10, type: 'market', stopPrice: 980, targetPrice: 1030 });
    expect(trader.positions.get('INFY')!.stop).toBe(980);
    await push(quote('INFY', 1031));
    expect(trader.positions.size).toBe(0);
    expect(db.recentTrades()[0].exit_reason).toMatch(/Target hit/);
  });

  it('stop-loss sells a manual position too', async () => {
    await push(quote('INFY', 1000));
    await trader.manualBuy({ symbol: 'INFY', qty: 10, type: 'market', stopPrice: 990 });
    await push(quote('INFY', 989));
    expect(trader.positions.size).toBe(0);
  });

  it('limit below price waits, then buys when price dips', async () => {
    await push(quote('TCS', 1000));
    const r = await trader.manualBuy({ symbol: 'TCS', qty: 5, type: 'limit', limitPrice: 990 });
    expect(r.status).toBe('pending');
    expect(trader.pending.size).toBe(1);
    await push(quote('TCS', 995));
    expect(trader.positions.size).toBe(0);
    await push(quote('TCS', 989));
    expect(trader.positions.has('TCS')).toBe(true);
    expect(trader.pending.size).toBe(0);
  });

  it('a waiting order can be cancelled', async () => {
    await push(quote('TCS', 1000));
    const r = await trader.manualBuy({ symbol: 'TCS', qty: 5, type: 'limit', limitPrice: 990 });
    trader.cancelPending(r.orderId!);
    expect(trader.pending.size).toBe(0);
    expect(() => trader.cancelPending(r.orderId!)).toThrow(/already gone/);
  });

  it('manual sell closes the position and records the trade', async () => {
    await push(quote('INFY', 1000));
    await trader.manualBuy({ symbol: 'INFY', qty: 10, type: 'market' });
    await trader.manualSell('INFY');
    expect(trader.positions.size).toBe(0);
    expect(db.recentTrades()[0].exit_reason).toBe('Manual sell');
    await expect(trader.manualSell('INFY')).rejects.toThrow(/do not hold/);
  });

  it('rejects bad input in plain words', async () => {
    await push(quote('INFY', 1000));
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 0, type: 'market' })).rejects.toThrow(/whole number/);
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 1.5, type: 'market' })).rejects.toThrow(/whole number/);
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 1, type: 'market', stopPrice: 1010 })).rejects.toThrow(/Stop must be below/);
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 1, type: 'market', targetPrice: 990 })).rejects.toThrow(/Target must be above/);
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 1, type: 'limit' })).rejects.toThrow(/limit price/);
    await expect(trader.manualBuy({ symbol: 'NOPRICE', qty: 1, type: 'market' })).rejects.toThrow(/No live price/);
  });

  it('refuses when the margin is more than free cash', async () => {
    await push(quote('MRF', 100000));
    // 5x leverage => 20,000 per share; 2 shares need 40,000 > 30,000
    await expect(trader.manualBuy({ symbol: 'MRF', qty: 2, type: 'market' })).rejects.toThrow(/margin/);
    await expect(trader.manualBuy({ symbol: 'MRF', qty: 1, type: 'market' })).resolves.toBeTruthy();
  });

  it('cannot buy the same share twice, but can trade again right after a kill-all', async () => {
    await push(quote('INFY', 1000));
    await trader.manualBuy({ symbol: 'INFY', qty: 1, type: 'market' });
    await expect(trader.manualBuy({ symbol: 'INFY', qty: 1, type: 'market' })).rejects.toThrow(/already hold/);
    await trader.killAll();
    await push(quote('TCS', 1000));
    await expect(trader.manualBuy({ symbol: 'TCS', qty: 1, type: 'market' })).resolves.toMatchObject({ status: 'filled' });
  });

  it('kill-all also drops waiting orders', async () => {
    await push(quote('TCS', 1000));
    await trader.manualBuy({ symbol: 'TCS', qty: 5, type: 'limit', limitPrice: 990 });
    await trader.killAll();
    expect(trader.pending.size).toBe(0);
  });

  it('two orders at the same time do not overspend cash', async () => {
    await push(quote('A', 10000), quote('B', 10000)); // 2,000 margin per share
    const results = await Promise.allSettled([
      trader.manualBuy({ symbol: 'A', qty: 10, type: 'market' }), // 20,000
      trader.manualBuy({ symbol: 'B', qty: 10, type: 'market' }), // 20,000 -> only one fits in 30,000
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('manual order API', () => {
  it('search, watch, buy, list and close through HTTP', async () => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const feed = new MockFeed(200);
    const trader = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5), realAllowed: false, patterns: [], ignoreMarketHours: true });
    const settings = defaultSettings(loadConfig());
    await feed.start(['RELIANCE'], (q) => { store.update(q); void trader.onQuotes(q); });
    const app = await buildApp({
      db, store, trader, feed, patterns: [],
      universe: { current: 'large', select: async () => undefined },
      settings: { get: () => settings, update: () => settings },
    });

    const search = await app.inject({ url: '/api/search?q=infy' });
    expect(search.json().map((x: { symbol: string }) => x.symbol)).toContain('INFY');

    // INFY is not in the watched list: the order endpoint starts watching it first
    const buy = await app.inject({ method: 'POST', url: '/api/orders', payload: { symbol: 'INFY', qty: 2, type: 'market', stopPct: 1 } });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().status).toBe('filled');

    const status = (await app.inject({ url: '/api/status' })).json();
    expect(status.positions.map((p: { symbol: string }) => p.symbol)).toContain('INFY');

    const bad = await app.inject({ method: 'POST', url: '/api/orders', payload: { symbol: 'INFY', qty: 2, type: 'market', side: 'SELL' } });
    expect(bad.statusCode).toBe(400);
    const junk = await app.inject({ method: 'POST', url: '/api/orders', payload: { symbol: 'NOT A SHARE', qty: 2, type: 'market' } });
    expect(junk.statusCode).toBe(400);

    const close = await app.inject({ method: 'POST', url: '/api/positions/INFY/close' });
    expect(close.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/status' })).json().positions).toHaveLength(0);

    const candles = await app.inject({ url: '/api/candles/INFY?interval=1minute&days=1' });
    expect(candles.json().length).toBeGreaterThan(30);
    feed.stop();
    await app.close();
  });
});

import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paperBroker.ts';
import { Db } from '../src/db/db.ts';
import { MarketStore } from '../src/market/store.ts';
import { parseRss, scoreHeadline, shouldBlock, summarise, NewsService } from '../src/news/news.ts';
import { buildPicks } from '../src/picks.ts';
import { defaultSettings, loadSettings, saveSettings, validateSettings } from '../src/settings.ts';
import { loadConfig } from '../src/config.ts';
import { AutoTrader } from '../src/trading/autoTrader.ts';
import { vwap } from '../src/trading/indicators.ts';
import type { Pattern } from '../src/trading/patterns.ts';
import type { Quote } from '../src/types.ts';

const rules = { capital: 30000, dailyLossCap: 500, maxOpenPositions: 2, riskPerTrade: 200, maxDayMovePct: 3, squareOffTime: '15:15' };
const goPattern: Pattern = { id: 't', name: 't', check: () => ({ pattern: 't', reason: 'r', stopPct: 0.01, score: 50 }) };
const quote = (symbol: string, ltp: number, prevClose = 100): Quote => ({ symbol, ltp, prevClose, open: prevClose, high: ltp, low: ltp, volume: 0, ts: Date.now() });

describe('settings', () => {
  const defaults = defaultSettings(loadConfig());

  it('has per-cap defaults: bigger move limit for smaller caps', () => {
    expect(defaults.lists.large.maxDayMovePct).toBeLessThan(defaults.lists.mid.maxDayMovePct);
    expect(defaults.lists.mid.maxDayMovePct).toBeLessThan(defaults.lists.small.maxDayMovePct);
  });

  it('accepts valid settings and saves/loads them', () => {
    const db = new Db(':memory:');
    const changed = structuredClone(defaults);
    changed.lists.small.maxDayMovePct = 15;
    saveSettings(db, validateSettings(changed));
    expect(loadSettings(db, defaults).lists.small.maxDayMovePct).toBe(15);
  });

  it('rejects out-of-range numbers with a plain message', () => {
    const bad = structuredClone(defaults);
    bad.lists.mid.riskPerTrade = -5;
    expect(() => validateSettings(bad)).toThrow(/mid: risk per trade/);
    const bad2 = structuredClone(defaults);
    bad2.lists.large.maxOpenPositions = 2.5;
    expect(() => validateSettings(bad2)).toThrow(/whole number/);
  });

  it('falls back to defaults when saved data is broken', () => {
    const db = new Db(':memory:');
    db.setSetting('app_settings', '{nope');
    expect(loadSettings(db, defaults)).toEqual(defaults);
  });
});

describe('news', () => {
  const xml = `<rss><channel>
    <item><title>Acme profit jumps 20%, beats estimates - Mint</title><link>http://a</link><pubDate>Thu, 05 Nov 2026 06:00:00 GMT</pubDate><source url="x">Mint</source></item>
    <item><title>Acme Q2 results on Friday &amp; board meeting</title><link>http://b</link><pubDate>Thu, 05 Nov 2026 05:00:00 GMT</pubDate><source url="x">ET</source></item>
  </channel></rss>`;
  const now = Date.parse('2026-11-05T08:00:00Z');

  it('parses RSS items', () => {
    const items = parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[1].title).toContain('& board meeting');
    expect(items[0].source).toBe('Mint');
  });

  it('scores good and bad headlines', () => {
    expect(scoreHeadline('Acme profit jumps, beats estimates')).toBeGreaterThan(0);
    expect(scoreHeadline('SEBI probe, penalty on Acme; stock plunges')).toBeLessThan(0);
  });

  it('flags results news and blocks on it', () => {
    const n = summarise('ACME', parseRss(xml), now);
    expect(n.resultsSoon).toBe(true);
    expect(shouldBlock(n)).toMatch(/results/);
  });

  it('blocks on clearly bad news', () => {
    const n = summarise('X', [{ title: 'Fraud probe: X plunges', link: '', source: '', ts: now }], now);
    expect(shouldBlock(n)).toMatch(/bad news/);
  });

  it('caches, and returns undefined when the network is down', async () => {
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new NewsService(ok);
    await svc.get('ACME');
    await svc.get('ACME');
    expect(calls).toBe(1);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await new NewsService(down).get('ACME')).toBeUndefined();
  });
});

describe('paper fills', () => {
  it('fill exactly at the market price for both buys and sells, with no made-up slippage', async () => {
    const b = new PaperBroker(() => 1000.04, undefined, 5);
    const buy = await b.placeOrder({ symbol: 'X', side: 'BUY', qty: 1, reason: '' });
    const sell = await b.placeOrder({ symbol: 'X', side: 'SELL', qty: 1, reason: '' });
    expect(buy.avgPrice).toBe(1000.05); // only rounded to the 5 paise tick
    expect(sell.avgPrice).toBe(1000.05);
  });
});

describe('VWAP and news gates in the trader', () => {
  const make = (extra: Partial<ConstructorParameters<typeof AutoTrader>[0]> = {}) => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const trader = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5), realAllowed: false, patterns: [goPattern], ignoreMarketHours: true, ...extra });
    return { db, store, trader };
  };

  it('vwap weights by volume', () => {
    expect(vwap([{ h: 10, l: 10, c: 10, v: 1 }, { h: 20, l: 20, c: 20, v: 3 }])).toBe(17.5);
  });

  it('skips a buy below VWAP when the filter is on', async () => {
    const { store, trader } = make();
    const q = quote('A', 90, 90);
    const t = Date.now();
    // today's candles traded around 100, so VWAP is ~100 and price 90 is below it
    store.seedCandles('A', Array.from({ length: 5 }, (_, i) => ({ t: t - (i + 2) * 60_000, o: 100, h: 100, l: 100, c: 100, v: 1000 })));
    store.update([q]);
    trader.start();
    await trader.onQuotes([q]);
    expect(trader.positions.size).toBe(0);
    trader.filters.requireAboveVwap = false;
    await trader.onQuotes([q]);
    expect(trader.positions.size).toBe(1);
  });

  it('skips a buy when the news check says so, and logs why', async () => {
    const { db, store, trader } = make({ newsCheck: async () => 'bad news' });
    const q = quote('A', 100);
    store.update([q]);
    trader.start();
    await trader.onQuotes([q]);
    expect(trader.positions.size).toBe(0);
    expect(db.recentEvents().some((e) => e.message.includes('skipped: bad news'))).toBe(true);
  });

  it('setRules changes limits for new entries', async () => {
    const { store, trader } = make();
    trader.setRules({ maxOpenPositions: 1 });
    const qs = [quote('A', 100), quote('B', 100)];
    store.update(qs);
    trader.start();
    await trader.onQuotes(qs);
    expect(trader.positions.size).toBe(1);
  });
});

describe('picks', () => {
  it('marks a pattern signal as buy and a bad-news share as avoid', async () => {
    const store = new MarketStore();
    store.update([quote('GOOD', 101), quote('BAD', 101), quote('QUIET', 100.5)]);
    const patterns: Pattern[] = [{ id: 'p', name: 'p', check: (q) => (q.symbol === 'QUIET' ? undefined : { pattern: 'p', reason: 'fired', stopPct: 0.01, score: 60 }) }];
    const news = {
      get: async (s: string) => (s === 'BAD' ? { symbol: s, score: -3, items: [{ title: 'Fraud probe', link: '', source: '', ts: 0 }], resultsSoon: false, fetchedAt: 0 } : { symbol: s, score: 1, items: [], resultsSoon: false, fetchedAt: 0 }),
    };
    const picks = await buildPicks({ store, patterns, news: news as never, maxDayMovePct: 3 });
    expect(picks.find((p) => p.symbol === 'GOOD')?.verdict).toBe('buy');
    expect(picks.find((p) => p.symbol === 'BAD')?.verdict).toBe('avoid');
    expect(picks[0].symbol).toBe('GOOD');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paperBroker.ts';
import { Db } from '../src/db/db.ts';
import { MarketStore } from '../src/market/store.ts';
import { buildPicks } from '../src/picks.ts';
import { AutoTrader } from '../src/trading/autoTrader.ts';
import { netPnl } from '../src/trading/charges.ts';
import {
  momentumBreakdown,
  openingRangeBreakdown,
  PATTERNS,
  SHORT_PATTERNS,
  tightRangeBreakdown,
  vwapRejection,
  type Pattern,
} from '../src/trading/patterns.ts';
import { chargesFor, grossPnl, netPnlFor, sideOf } from '../src/trading/pnl.ts';
import { defaultQuality, marketBlocksSide, qualityReject, qualitySummary } from '../src/trading/quality.ts';
import { initialStopShort, ladderStopShort } from '../src/trading/stops.ts';
import { defaultSettings, validateSettings } from '../src/settings.ts';
import type { Candle, Quote } from '../src/types.ts';

// 10:45 IST on a weekday = 05:15 UTC
const NOW = Date.UTC(2026, 10, 5, 5, 15, 30);
const MIN = Math.floor(NOW / 60_000) * 60_000;
const IST_OPEN = Date.UTC(2026, 10, 5, 3, 45); // 09:15 IST

/** 1-minute candles, oldest first, the last one ending a minute before NOW. */
function build(closes: number[], vol: (i: number) => number = () => 1000): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return { t: MIN - (closes.length - i) * 60_000, o: prev, h: Math.max(prev, c) + 0.05, l: Math.min(prev, c) - 0.05, c, v: vol(i) };
  });
}

const quote = (symbol: string, ltp: number, prevClose = 100, open = prevClose, ts = NOW): Quote => ({ symbol, ltp, prevClose, open, high: ltp, low: ltp, volume: 0, ts });

describe('short P&L maths', () => {
  it('a short makes money when price falls and loses when it rises', () => {
    expect(grossPnl('short', 100, 99, 10)).toBe(10);
    expect(grossPnl('short', 100, 101, 10)).toBe(-10);
    expect(grossPnl('long', 100, 101, 10)).toBe(10);
  });

  it('net profit is the sell at the entry and the buy at the exit, after charges', () => {
    expect(netPnlFor('short', 100, 99, 1000)).toBe(netPnl(99, 100, 1000));
    expect(netPnlFor('short', 100, 99, 1000)).toBeLessThan(grossPnl('short', 100, 99, 1000));
    expect(netPnlFor('short', 100, 99, 1000)).toBeGreaterThan(0);
    expect(chargesFor('short', 100, 99, 1000)).toBeGreaterThan(0);
    expect(netPnlFor('long', 100, 101, 1000)).toBe(netPnl(100, 101, 1000));
  });

  it('positions saved before shorting existed count as long', () => {
    expect(sideOf({})).toBe('long');
    expect(sideOf({ side: 'short' })).toBe('short');
  });
});

describe('short stops', () => {
  it('starts above the entry and is pulled down so the loss with charges fits the limit', () => {
    const stop = initialStopShort(1000, 100, 0.05, 500); // 5% above would lose far more than 500
    expect(stop).toBeGreaterThan(1000);
    expect(-netPnl(stop, 1000, 100)).toBeLessThanOrEqual(500);
    expect(initialStopShort(1000, 10, 0.01, 10_000)).toBe(1010); // plain 1% above when the limit allows it
  });

  it('follows the lowest price down in steps and never moves back up', () => {
    const rule = { stepPct: 0.5 };
    const start = 1010;
    expect(ladderStopShort(1000, 100, 998, start, rule)).toBe(start); // not one step yet
    const be = ladderStopShort(1000, 100, 994.9, start, rule); // one step: break-even (below entry, covers charges)
    expect(be).toBeLessThan(1000);
    expect(-netPnl(be, 1000, 100)).toBeLessThanOrEqual(0.01); // not a loss
    const locked = ladderStopShort(1000, 100, 990, be, rule); // 1% down: locks half a percent
    expect(locked).toBeLessThan(be);
    expect(locked).toBeCloseTo(995, 0);
    expect(ladderStopShort(1000, 100, 999, locked, rule)).toBe(locked); // price bounces: stop stays
  });
});

describe('short patterns', () => {
  /** Candles from 09:15 IST for `count` minutes ending a minute before NOW. */
  const dayFrom = (count: number, price: (i: number) => number, vol: (i: number) => number): Candle[] => {
    const start = MIN - count * 60_000;
    return Array.from({ length: count }, (_, i) => {
      const c = price(i);
      const o = i === 0 ? c : price(i - 1);
      return { t: start + i * 60_000, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: vol(i) };
    });
  };

  it('are all marked short, and listed after the long ones', () => {
    expect(SHORT_PATTERNS.length).toBeGreaterThanOrEqual(5);
    expect(PATTERNS.filter((p) => SHORT_PATTERNS.includes(p))).toHaveLength(SHORT_PATTERNS.length);
  });

  it('opening range breakdown: fires on a fresh close under the 15-minute low with volume', () => {
    const n = (Math.floor((NOW - IST_OPEN) / 60_000)) ; // minutes since 09:15
    const cs = dayFrom(n, (i) => (i < 15 ? 100 + 0.2 * Math.sin(i) : i === n - 1 ? 99.5 : i === n - 2 ? 99.9 : 100), (i) => (i === n - 1 ? 3000 : 1000));
    cs.forEach((c, i) => { c.t = IST_OPEN + i * 60_000; });
    const s = openingRangeBreakdown.check(quote('X', 99.5, 100, 100), cs);
    expect(s?.pattern).toBe('orb15s');
    expect(s?.side).toBe('short');
    expect(s!.stopPct).toBeGreaterThanOrEqual(0.005);
    // thin volume: no signal
    const thin = cs.map((c, i) => (i === n - 1 ? { ...c, v: 900 } : c));
    expect(openingRangeBreakdown.check(quote('X', 99.5, 100, 100), thin)).toBeUndefined();
    // a break that was already running: no signal
    const running = cs.map((c, i) => (i === n - 2 ? { ...c, c: 99.6, l: 99.55 } : c));
    expect(openingRangeBreakdown.check(quote('X', 99.5, 100, 100), running)).toBeUndefined();
  });

  it('VWAP rejection: fires when a bounce to resistance is rejected under EMA9 on volume, never for a rising share', () => {
    // mirror of the long pullback: falls to ~98, bounces up to resistance, then a red candle rejects it
    const path = [...Array.from({ length: 28 }, (_, i) => 100 - i * 0.07), 98.05, 98.25, 98.45, 98.6, 98.7, 98.55, 98.1];
    const cs = build(path, (i) => (i === path.length - 1 ? 2000 : 1000));
    const s = vwapRejection.check(quote('X', 98.05), cs);
    expect(s?.pattern).toBe('vwaprj');
    expect(s?.side).toBe('short');
    expect(s!.stopPct).toBeGreaterThanOrEqual(0.004);
    expect(s!.stopPct).toBeLessThanOrEqual(0.01);
    expect(vwapRejection.check(quote('X', 98.05), build(path))).toBeUndefined(); // thin volume
    expect(vwapRejection.check(quote('X', 101.5, 100), cs)).toBeUndefined(); // up on the day: not a short
  });

  it('tight range breakdown: quiet 12 minutes, then a close under the range on volume', () => {
    const flat = Array.from({ length: 20 }, (_, i) => 99.9 + (i % 2 ? 0.05 : -0.05));
    const closes = [...flat, 99.4];
    const cs = build(closes, (i) => (i === closes.length - 1 ? 3000 : 1000));
    const s = tightRangeBreakdown.check(quote('X', 99.35), cs);
    expect(s?.pattern).toBe('squeezes');
    expect(s?.side).toBe('short');
    expect(tightRangeBreakdown.check(quote('X', 99.35), build(closes))).toBeUndefined(); // thin volume
  });

  it('momentum breakdown: down 2%+ and a fresh close under the 20-candle low on 2x volume', () => {
    const base: Candle[] = [];
    for (let i = 30; i >= 1; i--) base.push({ t: MIN - i * 60_000, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000 });
    const last = base[base.length - 1];
    last.c = 96.5;
    last.l = 96.4;
    last.v = 5000;
    const s = momentumBreakdown.check(quote('X', 96.4), base);
    expect(s?.pattern).toBe('moms');
    expect(s?.side).toBe('short');
    expect(momentumBreakdown.check(quote('X', 99), base)).toBeUndefined(); // only down 1%
  });
});

describe('short quality checks', () => {
  const rules = { ...defaultQuality, enabled: true, targetPct: 1 };
  const down = Array.from({ length: 30 }, (_, i) => 100 - i * 0.03 + (i % 2 ? 0.04 : -0.04)); // zig-zag downtrend
  const sig = (stopPct: number) => ({ pattern: 't', reason: 'r', stopPct, score: 60, side: 'short' as const });

  it('accepts a healthy downtrend below VWAP with a tight stop', () => {
    expect(qualityReject(quote('X', 99.1), build(down), sig(0.005), rules)).toBeUndefined();
  });

  it('rejects a short above VWAP, one that chases the fall, and an uptrend', () => {
    expect(qualityReject(quote('X', 101), build(down), sig(0.005), rules)).toMatch(/above today's average price/);
    expect(qualityReject(quote('X', 97), build(down), sig(0.005), rules)).toMatch(/stretched more than 1.2% below VWAP/);
    const up = Array.from({ length: 30 }, (_, i) => 100 + i * 0.03 + (i % 2 ? -0.04 : 0.04));
    expect(qualityReject(quote('X', 99.5), build(up), sig(0.005), rules)).toMatch(/not down|momentum is not weak/);
  });

  it('rejects an oversold straight-line fall', () => {
    const fall = Array.from({ length: 30 }, (_, i) => 100 - i * 0.03);
    expect(qualityReject(quote('X', 99.1), build(fall), sig(0.005), rules)).toMatch(/oversold/);
  });

  it('explains what it checked, in words for a short', () => {
    const text = qualitySummary(quote('X', 99.1), build(down), rules, sig(0.005));
    expect(text).toMatch(/below VWAP/);
    expect(text).toMatch(/EMA9 .* below EMA21/);
  });

  it('shorts sit out a strong market, longs sit out a weak one', () => {
    expect(marketBlocksSide('short', 0.6, rules)).toMatch(/market is strong/);
    expect(marketBlocksSide('short', -0.6, rules)).toBeUndefined();
    expect(marketBlocksSide('long', -0.6, rules)).toMatch(/market is weak/);
    expect(marketBlocksSide('long', 0.6, rules)).toBeUndefined();
    expect(marketBlocksSide('short', undefined, rules)).toBeUndefined();
  });
});

describe('the Picks tab stays a list of buy ideas', () => {
  it('leaves short signals out', async () => {
    const store = new MarketStore();
    const goShort: Pattern = { id: 'sh', name: 'sh', check: () => ({ pattern: 'sh', side: 'short', reason: 'x', stopPct: 0.01, score: 90 }) };
    store.update(Array.from({ length: 3 }, (_, i) => quote(`S${i}`, 103)));
    const picks = await buildPicks({ store, patterns: [goShort], maxDayMovePct: 10 });
    expect(picks.flatMap((p) => p.signals)).toEqual([]);
  });
});

describe('short selling in the trader (paper)', () => {
  const rules = { capital: 100_000, dailyLossCap: 5000, maxOpenPositions: 5, riskPerTrade: 500, maxDayMovePct: 5, squareOffTime: '15:15' };
  const goShort: Pattern = {
    id: 'tshort',
    name: 'tshort',
    check: (q) => (q.symbol.startsWith('SH') ? { pattern: 'tshort', side: 'short', reason: 'test short signal', stopPct: 0.01, score: 50 } : undefined),
  };
  let db: Db;
  let store: MarketStore;
  let trader: AutoTrader;
  const push = async (...qs: Quote[]) => {
    store.update(qs);
    await trader.onQuotes(qs);
  };
  const make = (extra: Partial<ConstructorParameters<typeof AutoTrader>[0]> = {}) =>
    new AutoTrader({ rules, db, store, paperBroker: new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5), realAllowed: false, patterns: [goShort], ignoreMarketHours: true, ...extra });

  beforeEach(() => {
    db = new Db(':memory:');
    store = new MarketStore();
    trader = make();
  });

  describe('manual short', () => {
    it('is refused until short selling is switched on', async () => {
      store.update([quote('AAA', 1000, 1000)]);
      await expect(trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short' })).rejects.toThrow(/switched off/);
    });

    it('opens a short at the market price with the stop above and the target below', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      const r = await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010, targetPrice: 980 });
      expect(r.status).toBe('filled');
      const p = trader.positions.get('AAA')!;
      expect(p).toMatchObject({ side: 'short', entry: 1000, stop: 1010, target: 980, qty: 10, pattern: 'manual', reason: 'Manual short' });
      expect(db.recentEvents(5).some((e) => /^MANUAL SHORT 10 AAA @ 1000/.test(e.message))).toBe(true);
      expect(trader.canShort).toBe(true);
      expect(trader.status().positions[0]).toMatchObject({ side: 'short', pnl: 0 });
    });

    it('checks the stop and target are on the right side, and only allows market orders', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await expect(trader.manualBuy({ symbol: 'AAA', qty: 1, type: 'market', side: 'short', stopPrice: 990 })).rejects.toThrow(/Stop must be above the short price/);
      await expect(trader.manualBuy({ symbol: 'AAA', qty: 1, type: 'market', side: 'short', targetPrice: 1010 })).rejects.toThrow(/Target must be below the short price/);
      await expect(trader.manualBuy({ symbol: 'AAA', qty: 1, type: 'limit', limitPrice: 1010, side: 'short' })).rejects.toThrow(/market orders only/);
    });

    it('shows profit when price falls, loss when it rises, before charges', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1020 });
      await push(quote('AAA', 1005, 1000)); // price up: a short loses
      expect(trader.status().positions[0].pnl).toBe(-50);
      await push(quote('AAA', 995, 1000)); // price down: a short wins
      expect(trader.status().positions[0].pnl).toBe(50);
      expect(trader.status().unrealized).toBe(50);
      expect(trader.unrealized()).toBeLessThan(50); // the loss cap still counts charges
    });

    it('is covered at the stop when price rises, recorded as a short trade with the right loss', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010 });
      await push(quote('AAA', 1010, 1000));
      expect(trader.positions.size).toBe(0);
      const t = db.recentTrades(1)[0];
      expect(t).toMatchObject({ symbol: 'AAA', side: 'short', entry_price: 1000, exit_price: 1010, qty: 10 });
      expect(t.net_pnl).toBe(netPnl(1010, 1000, 10));
      expect(t.net_pnl).toBeLessThan(-100); // 10 x 10 loss plus charges
      expect(trader.realizedToday).toBe(t.net_pnl);
      expect(db.recentEvents(3).some((e) => /^COVER 10 AAA @ 1010/.test(e.message))).toBe(true);
    });

    it('is covered at the target when price falls, with a profit', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1020, targetPrice: 980 });
      await push(quote('AAA', 980, 1000));
      expect(trader.positions.size).toBe(0);
      const t = db.recentTrades(1)[0];
      expect(t.side).toBe('short');
      expect(t.net_pnl).toBeGreaterThan(150);
      expect(t.exit_reason).toMatch(/Target hit/);
    });

    it('moves the stop down as price falls (the profit ladder) and covers when it bounces back to it', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010 });
      await push(quote('AAA', 985, 1000)); // 1.5% down: three steps
      const p = trader.positions.get('AAA')!;
      expect(p.stop).toBeLessThan(1000); // now below the entry
      expect(p.highest).toBe(985); // tracks the lowest price
      await push(quote('AAA', p.stop, 1000)); // price comes back up to the new stop
      expect(trader.positions.size).toBe(0);
      expect(db.recentTrades(1)[0].net_pnl).toBeGreaterThan(0); // locked in a profit
    });

    it('can be closed by hand: the close buys it back', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010 });
      await trader.manualSell('AAA');
      expect(trader.positions.size).toBe(0);
      expect(db.recentTrades(1)[0]).toMatchObject({ side: 'short', exit_reason: 'Manual cover (buy back)' });
    });

    it('counts the margin and the loss cap like a long', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010 });
      expect(trader.freeCash).toBe(100_000 - 10 * 200); // 5x leverage: 200 per share
      await push(quote('AAA', 1500, 1000)); // far through the stop: the loss cap ends the day
      expect(trader.positions.size).toBe(0);
    });
  });

  describe('automatic shorts', () => {
    it('are never taken while short selling is off', async () => {
      trader.start();
      await push(quote('SHARE', 1000, 1000));
      expect(trader.positions.size).toBe(0);
    });

    it('open a short on a bearish signal with the stop above, the target below and the reason saved', async () => {
      trader.allowShort = true;
      trader.quality = { ...trader.quality, targetPct: 2 };
      trader.start();
      await push(quote('SHARE', 1000, 1000));
      const p = trader.positions.get('SHARE')!;
      expect(p.side).toBe('short');
      expect(p.stop).toBeGreaterThan(1000);
      expect(p.stop).toBeLessThanOrEqual(1010); // the 1% stop, or tighter if the risk cap pulls it in
      expect(p.target).toBe(980);
      expect(p.reason).toContain('test short signal');
      expect(db.recentEvents(5).some((e) => /^SHORT \d+ SHARE @ 1000/.test(e.message))).toBe(true);
      // and it is covered at the stop
      await push(quote('SHARE', p.stop, 1000));
      expect(trader.positions.size).toBe(0);
      expect(db.recentTrades(1)[0]).toMatchObject({ side: 'short', pattern: 'tshort' });
    });

    it('size a short by the same risk and capital rules as a long', async () => {
      trader.allowShort = true;
      trader.paperCash = 300_000;
      trader.capitalPerTrade = 20_000;
      trader.start();
      await push(quote('SHARE', 1000, 1000));
      expect(trader.positions.get('SHARE')!.qty).toBe(100); // 20000 margin at 5x = 1 lakh of shares
    });

    it('ask the news check about a SHORT (good news is a reason to skip)', async () => {
      const calls: string[] = [];
      trader = make({ newsCheck: async (s, side) => { calls.push(`${s}:${side}`); return side === 'short' ? 'good news (score 3)' : undefined; } });
      trader.allowShort = true;
      trader.start();
      await push(quote('SHARE', 1000, 1000));
      expect(calls).toContain('SHARE:short');
      expect(trader.positions.size).toBe(0);
    });

    it('skip a short in a strong market and log why', async () => {
      trader.allowShort = true;
      trader.quality = { ...trader.quality, enabled: true, firstEntryMin: 0, lastEntryMinutes: 24 * 60 };
      trader.start();
      const market = Array.from({ length: 25 }, (_, i) => quote(`M${i}`, 1010, 1000)); // median +1%
      await push(...market, quote('SHARE', 1000, 1000));
      expect(trader.positions.size).toBe(0);
      expect(db.recentEvents(10).some((e) => /SKIP SHARE: tshort fired but market is strong/.test(e.message))).toBe(true);
    });
  });

  describe('restart', () => {
    it('brings a short back with its side, stop above and target below', async () => {
      trader.allowShort = true;
      store.update([quote('AAA', 1000, 1000)]);
      await trader.manualBuy({ symbol: 'AAA', qty: 10, type: 'market', side: 'short', stopPrice: 1010, targetPrice: 980 });
      const again = make();
      const p = again.positions.get('AAA')!;
      expect(p).toMatchObject({ side: 'short', entry: 1000, stop: 1010, target: 980 });
      trader = again;
      trader.allowShort = false; // even with shorting switched off, an open short is still watched and covered
      await push(quote('AAA', 1011, 1000));
      expect(trader.positions.size).toBe(0);
      expect(db.recentTrades(1)[0].side).toBe('short');
    });
  });

  describe('settings', () => {
    it('short selling is on by default (paper only) and must be a plain on or off', () => {
      const d = defaultSettings({ money: { capital: 50000, riskPerTrade: 500, maxOpenPositions: 5, dailyLossCap: 2000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never);
      expect(d.shortSelling).toBe(true);
      expect(validateSettings({ ...d, shortSelling: true }).shortSelling).toBe(true);
      const old = JSON.parse(JSON.stringify(d));
      delete old.shortSelling;
      expect(validateSettings(old).shortSelling).toBe(true);
      expect(() => validateSettings({ ...d, shortSelling: 'yes' })).toThrow(/short selling must be on or off/);
    });
  });
});

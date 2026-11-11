import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/broker/paperBroker.ts';
import type { Broker } from '../src/broker/broker.ts';
import { Db } from '../src/db/db.ts';
import { MarketStore } from '../src/market/store.ts';
import { AutoTrader, REAL_CONFIRM_TEXT } from '../src/trading/autoTrader.ts';
import type { Pattern } from '../src/trading/patterns.ts';
import type { Quote } from '../src/types.ts';

const rules = {
  capital: 30000,
  dailyLossCap: 500,
  maxOpenPositions: 2,
  riskPerTrade: 200,
  maxDayMovePct: 3,
  squareOffTime: '15:15',
};

// Fires for any symbol whose name starts with "GO".
const alwaysGo: Pattern = {
  id: 'test',
  name: 'test',
  check: (q) => (q.symbol.startsWith('GO') ? { pattern: 'test', reason: 'test signal', stopPct: 0.01, score: 50 } : undefined),
};

function quote(symbol: string, ltp: number, prevClose = 1000): Quote {
  return { symbol, ltp, prevClose, open: prevClose, high: ltp, low: ltp, volume: 0, ts: Date.now() };
}

describe('AutoTrader (paper)', () => {
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
    const paper = new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5);
    trader = new AutoTrader({ rules, db, store, paperBroker: paper, realAllowed: false, patterns: [alwaysGo], ignoreMarketHours: true });
  });

  it('starts in paper mode and stopped', () => {
    expect(trader.mode).toBe('paper');
    expect(trader.running).toBe(false);
  });

  it('does nothing while stopped', async () => {
    await push(quote('GOOD', 1000));
    expect(trader.positions.size).toBe(0);
  });

  it('buys on a signal, sized by risk, with a capped stop', async () => {
    trader.start();
    await push(quote('GOOD', 1000));
    const p = trader.positions.get('GOOD')!;
    expect(p.qty).toBe(20);
    expect(p.stop).toBeLessThan(1000);
    expect(p.stop).toBeGreaterThanOrEqual(990);
  });

  it('sets the profit target and sells when it is reached', async () => {
    trader.quality.targetPct = 1;
    trader.start();
    await push(quote('GOOD', 1000));
    const p = trader.positions.get('GOOD')!;
    expect(p.target).toBeGreaterThanOrEqual(1010);
    expect(p.target).toBeLessThan(1012);
    await push(quote('GOOD', p.target!));
    expect(trader.positions.has('GOOD')).toBe(false);
  });

  it('uses the paper cash setting for free cash in paper mode', async () => {
    expect(trader.freeCash).toBe(30000); // rules.capital until a paper cash is set
    trader.paperCash = 100000;
    expect(trader.freeCash).toBe(100000);
    expect(trader.status().rules.capital).toBe(100000);
    trader.start();
    await push(quote('GOOD', 1000));
    expect(trader.freeCash).toBeLessThan(100000); // margin for the open position is taken from the paper cash
    expect(trader.freeCash).toBeGreaterThan(80000);
  });

  it('buys with a fixed capital per trade (20000 margin at 5x = 1 lakh) and keeps the chart stop', async () => {
    trader.paperCash = 200000;
    trader.capitalPerTrade = 20000;
    trader.start();
    await push(quote('GOOD', 1000));
    const p = trader.positions.get('GOOD')!;
    expect(p.qty).toBe(100); // 100000 of shares
    expect(p.marginUsed).toBe(20000);
    expect(p.stop).toBeCloseTo(990, 0); // the 1% pattern stop, not squeezed by the 200 risk cap
  });

  it('opens at most the allowed number of new trades per minute', async () => {
    trader.paperCash = 500000;
    trader.entriesPerMinute = 1;
    trader.start();
    await push(quote('GOONE', 1000), quote('GOTWO', 1000), quote('GOTHREE', 1000));
    expect(trader.positions.size).toBe(1);
  });

  it('skips shares that already moved too much today', async () => {
    trader.start();
    await push(quote('GOFAST', 1050, 1000)); // +5%
    expect(trader.positions.size).toBe(0);
  });

  it('logs why a share was skipped, once, not every second', async () => {
    trader.start();
    await push(quote('GOFAST', 1050, 1000));
    await push(quote('GOFAST', 1051, 1000));
    await push(quote('GOFAST', 1052, 1000));
    const skips = db.recentEvents(50).filter((e) => e.message.startsWith('SKIP GOFAST'));
    expect(skips).toHaveLength(1);
    expect(skips[0].message).toContain('already moved 5.0% today (limit 3%)');
  });

  it('logs when the quality check skips a signal', async () => {
    trader.quality = { ...trader.quality, enabled: true, targetPct: 1, stopLossPct: 0.5 };
    trader.start();
    await push(quote('GOOD', 1000)); // the test pattern's 1% stop is wider than the 0.5% limit
    expect(trader.positions.size).toBe(0);
    expect(db.recentEvents(20).some((e) => /SKIP GOOD: test fired but stop 1.00% is wider than allowed/.test(e.message))).toBe(true);
  });

  it('saves the reason and the checks it passed with the buy', async () => {
    trader.quality = { ...trader.quality, enabled: true, targetPct: 3, stopLossPct: 2, firstEntryMin: 0, lastEntryMinutes: 24 * 60 };
    trader.start();
    await push(quote('GOOD', 1000));
    const p = trader.positions.get('GOOD')!;
    expect(p.reason).toMatch(/test signal. Checks passed: score 50, stop 1.00%, target 3%/);
  });

  it('takes a bigger mover once the day-move limit is raised (small-cap list)', async () => {
    trader.setMaxDayMovePct(12);
    trader.start();
    await push(quote('GOMOVER', 1080, 1000)); // +8%
    expect(trader.positions.has('GOMOVER')).toBe(true);
  });

  it('respects max open positions', async () => {
    trader.start();
    await push(quote('GOA', 1000), quote('GOB', 1000), quote('GOC', 1000));
    expect(trader.positions.size).toBe(2);
  });

  it('sells when the stop is hit and records the trade with reasons', async () => {
    trader.start();
    await push(quote('GOOD', 1000));
    const stop = trader.positions.get('GOOD')!.stop;
    await push(quote('GOOD', stop));
    expect(trader.positions.size).toBe(0);
    const [t] = db.recentTrades();
    expect(t.symbol).toBe('GOOD');
    expect(t.entry_reason).toBe('test signal');
    expect(t.exit_reason).toMatch(/Stop hit/);
    expect(t.net_pnl).toBeLessThan(0);
    // Exit at the stop: loss incl. charges stays within the per-trade risk.
    expect(t.net_pnl).toBeGreaterThanOrEqual(-rules.riskPerTrade);
  });

  it('does not re-enter the same share the same day', async () => {
    trader.start();
    await push(quote('GOOD', 1000));
    await push(quote('GOOD', 985));
    await push(quote('GOOD', 1000));
    expect(trader.positions.size).toBe(0);
  });

  it('moves the stop up the ladder as price rises', async () => {
    trader.start();
    await push(quote('GOOD', 1000));
    await push(quote('GOOD', 1015));
    expect(trader.positions.get('GOOD')!.stop).toBe(1010);
  });

  it('kill-all sells everything and blocks restart for the day', async () => {
    trader.start();
    await push(quote('GOA', 1000), quote('GOB', 1000));
    await trader.killAll();
    expect(trader.positions.size).toBe(0);
    expect(trader.running).toBe(false);
    expect(() => trader.start()).toThrow(/Stopped for today/);
  });

  it('daily loss cap stops trading', async () => {
    trader = new AutoTrader({
      rules: { ...rules, dailyLossCap: 100 },
      db,
      store,
      paperBroker: new PaperBroker((s) => store.quote(s)?.ltp, undefined, 5),
      realAllowed: false,
      patterns: [alwaysGo],
      ignoreMarketHours: true,
    });
    trader.start();
    await push(quote('GOOD', 1000));
    await push(quote('GOOD', 994)); // ~₹120+ open loss, above stop
    expect(trader.haltedReason).toMatch(/Daily loss cap/);
    expect(trader.positions.size).toBe(0);
  });
});

describe('real money lock', () => {
  const fakeReal: Broker = {
    name: 'fake-upstox',
    placeOrder: async () => {
      throw new Error('must not be called');
    },
    getMargin: async (symbol, _q, price) => ({ symbol, leverage: 5, marginPerShare: price / 5 }),
  };

  it('refuses real mode when REAL_TRADING_ENABLED is false', () => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const t = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker(() => 1), realBroker: fakeReal, realAllowed: false, patterns: [] });
    expect(() => t.setMode('real', REAL_CONFIRM_TEXT)).toThrow(/locked/);
    expect(t.mode).toBe('paper');
  });

  it('needs the exact confirm text even when unlocked', () => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const t = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker(() => 1), realBroker: fakeReal, realAllowed: true, patterns: [] });
    expect(() => t.setMode('real', 'yes')).toThrow(/Type exactly/);
    t.setMode('real', REAL_CONFIRM_TEXT);
    expect(t.mode).toBe('real');
    expect(t.running).toBe(false);
  });

  it('does not come back in real mode after restart if the lock is closed', () => {
    const db = new Db(':memory:');
    db.setSetting('mode', 'real');
    const t = new AutoTrader({ rules, db, store: new MarketStore(), paperBroker: new PaperBroker(() => 1), realBroker: fakeReal, realAllowed: false, patterns: [] });
    expect(t.mode).toBe('paper');
  });
});

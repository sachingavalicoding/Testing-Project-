import { describe, expect, it } from 'vitest';
import { Db, type TradeRow } from '../src/db/db.ts';
import { MarketStore } from '../src/market/store.ts';
import { defaultSettings, loadSettings, saveSettings, validateScanner, validateSettings } from '../src/settings.ts';
import { exitAdvice, costPrice } from '../src/scanner/exitHelp.ts';
import { dayBlocks, phaseAt, readMarket } from '../src/scanner/guards.ts';
import { learnStats, matchTrades, type SavedPick } from '../src/scanner/learn.ts';
import { buildPlan } from '../src/scanner/plan.ts';
import { baseScore, buildWatchlist, gapPct } from '../src/scanner/premarket.ts';
import { scoreStock } from '../src/scanner/score.ts';
import { ScannerService } from '../src/scanner/service.ts';
import { defaultScanner, type DailyInfo } from '../src/scanner/types.ts';
import { aggregate, atr, macdHist } from '../src/scanner/util.ts';
import type { Candle, Quote } from '../src/types.ts';

// 2026-11-05 (a Thursday). IST = UTC + 5:30.
const ist = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 5, h, m, s) - 5.5 * 3600_000;
const T1100 = ist(11, 0, 30);

/** 1-minute candles from 09:15 IST up to (not including) `endMin`. price(i) is the close of minute i. */
function day(price: (i: number) => number, vol: (i: number) => number, minutes = 105): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < minutes; i++) {
    const c = price(i);
    const o = i === 0 ? c : price(i - 1);
    out.push({ t: ist(9, 15) + i * 60_000, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: vol(i) });
  }
  return out;
}

/** A clean breakout day: tight opening range near 100, then a steady climb to about 103 with a volume surge at the end. */
const climb = day(
  (i) => (i < 15 ? 100 + 0.2 * Math.sin(i) : 100.3 + (i - 15) * 0.03),
  (i) => (i >= 100 ? 3000 : 1000),
);
const faller = day((i) => 100 - i * 0.02, () => 1000);

const quote = (symbol: string, ltp: number, ts = T1100, prevClose = 100, open = prevClose): Quote => ({ symbol, ltp, prevClose, open, high: ltp, low: prevClose - 1, volume: 0, ts });
const daily: DailyInfo = { prevHigh: 101, prevLow: 98.5, prevClose: 100, prevVolume: 2_000_000, avgVolume: 1_800_000 };

describe('scanner helpers', () => {
  it('aggregates into candles lined up with the NSE clock', () => {
    const five = aggregate(climb.slice(0, 15), 5);
    expect(five).toHaveLength(3);
    expect(five[0].t).toBe(ist(9, 15));
    expect(five[0].v).toBe(5000);
    expect(five[2].c).toBe(climb[14].c);
  });
  it('measures ATR and the MACD histogram', () => {
    expect(atr(climb.slice(0, 10), 14)).toBeUndefined();
    expect(atr(climb, 14)!).toBeGreaterThan(0);
    expect(macdHist(climb.map((c) => c.c).slice(0, 20))).toBeUndefined();
    expect(macdHist(climb.map((c) => c.c))).toBeDefined();
  });
});

describe('scoreStock', () => {
  it('gives a strong, volume-backed breakout a high score with every part explained', () => {
    const r = scoreStock({ q: quote('UP', 103), candles: climb, daily, marketPct: 0 });
    const get = (k: string) => r.parts.find((p) => p.key === k)!;
    expect(get('trend').points).toBe(30);
    expect(get('breakout').points).toBe(20);
    expect(get('volume').points).toBe(20);
    expect(get('strength').points).toBe(15);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.setup).toBe('orb');
    expect(r.parts.every((p) => p.note.length > 0)).toBe(true);
  });

  it('scores a falling share below VWAP very low', () => {
    const r = scoreStock({ q: quote('DOWN', 97.9), candles: faller, daily, marketPct: 0 });
    expect(r.score).toBeLessThan(25);
  });

  it('says so when data is missing instead of inventing it', () => {
    const r = scoreStock({ q: quote('NEW', 100.5), candles: climb.slice(0, 5) });
    expect(r.parts.find((p) => p.key === 'volume')!.note).toMatch(/not enough/);
    expect(r.parts.find((p) => p.key === 'strength')!.note).toMatch(/not available/);
    expect(r.parts.find((p) => p.key === 'breakout')!.note).toMatch(/yesterday's high not available/);
  });

  it('uses yesterday\'s high as the breakout when the opening range has not been broken', () => {
    const flat = day((i) => 100 + 0.2 * Math.sin(i), () => 1000);
    const r = scoreStock({ q: quote('PDH', 101.2), candles: flat, daily: { ...daily, prevHigh: 101 }, marketPct: 0 });
    expect(r.setup).toBe('orb'); // above the range high too
    const r2 = scoreStock({ q: quote('PDH', 100.1), candles: flat, daily: { ...daily, prevHigh: 100.2 }, marketPct: 0 });
    expect(r2.parts.find((p) => p.key === 'breakout')!.note).toMatch(/just under yesterday's high/);
  });
});

describe('buildPlan', () => {
  it('makes a full plan: entry zone, stop, 1R and 2R, size from risk including charges', () => {
    const r = buildPlan(quote('UP', 103), climb, defaultScanner);
    expect('plan' in r).toBe(true);
    if (!('plan' in r)) return;
    const p = r.plan;
    expect(p.stop).toBeLessThan(p.entryLow);
    expect(p.entryHigh).toBeGreaterThanOrEqual(p.entryLow);
    const risk = p.entryHigh - p.stop;
    expect(p.target1).toBeCloseTo(p.entryHigh + risk, 1);
    expect(p.target2).toBeCloseTo(p.entryHigh + 2 * risk, 1);
    expect(p.rr1).toBeCloseTo(1, 1);
    expect(p.rr2).toBeCloseTo(2, 1);
    expect(p.riskAfterCharges).toBeLessThanOrEqual(defaultScanner.riskPerTrade);
    expect(p.qty).toBeGreaterThan(0);
    expect(p.gain2AfterCharges).toBeGreaterThan(p.gain1AfterCharges);
    expect(p.stopPct).toBeGreaterThanOrEqual(defaultScanner.minStopPct - 0.01);
    expect(p.stopPct).toBeLessThanOrEqual(defaultScanner.maxStopPct);
    expect(p.stopHow.length).toBeGreaterThan(5);
    expect(p.invalidIf.length).toBeGreaterThanOrEqual(4);
    expect(p.invalidIf.join(' ')).toContain(p.stop.toFixed(2));
  });

  it('gives a smaller size for a smaller risk amount and never exceeds it', () => {
    const big = buildPlan(quote('UP', 103), climb, { ...defaultScanner, riskPerTrade: 1000 });
    const small = buildPlan(quote('UP', 103), climb, { ...defaultScanner, riskPerTrade: 250 });
    if (!('plan' in big) || !('plan' in small)) throw new Error('expected plans');
    expect(small.plan.qty).toBeLessThan(big.plan.qty);
    expect(small.plan.riskAfterCharges).toBeLessThanOrEqual(250);
  });

  it('refuses in words when there is not enough data, the stop is too wide, or risk is too small', () => {
    expect(buildPlan(quote('NEW', 100), climb.slice(0, 6), defaultScanner)).toMatchObject({ reason: expect.stringMatching(/not enough candles/) });
    expect(buildPlan(quote('UP', 103), climb, { ...defaultScanner, minStopPct: 0.05, maxStopPct: 0.1 })).toMatchObject({ reason: expect.stringMatching(/your limit is 0.1%/) });
    expect(buildPlan(quote('UP', 103), climb, { ...defaultScanner, riskPerTrade: 0.3 })).toMatchObject({ reason: expect.stringMatching(/too small/) });
  });
});

describe('market read, phases and blocks', () => {
  const flatQuotes = Array.from({ length: 30 }, (_, i) => quote(`F${i}`, 100 + (i % 3 === 0 ? 0.05 : -0.05)));
  const risingQuotes = Array.from({ length: 30 }, (_, i) => quote(`R${i}`, 101 + (i % 3) * 0.2));

  it('calls a flat list choppy and a rising list not', () => {
    expect(readMarket(flatQuotes, defaultScanner).choppy).toBe(true);
    expect(readMarket(risingQuotes, defaultScanner).choppy).toBe(false);
    expect(readMarket(flatQuotes.slice(0, 5), defaultScanner).text).toMatch(/Not enough/);
  });

  it('knows the phase of the day from the settings', () => {
    expect(phaseAt(ist(9, 0), defaultScanner).phase).toBe('pre-open');
    expect(phaseAt(ist(9, 17), defaultScanner).phase).toBe('waiting'); // first 5 minutes are blocked
    expect(phaseAt(ist(9, 21), defaultScanner).phase).toBe('scanning');
    expect(phaseAt(ist(14, 31), defaultScanner).phase).toBe('closed');
    // your own times, no hidden caps
    expect(phaseAt(ist(15, 0), { ...defaultScanner, scanTo: '15:10' }).phase).toBe('scanning');
    expect(phaseAt(ist(9, 25), { ...defaultScanner, noEntryFirstMinutes: 15 }).phase).toBe('waiting');
  });

  it('blocks on a choppy market and after the daily loss limit, each switchable', () => {
    const choppy = readMarket(flatQuotes, defaultScanner);
    expect(dayBlocks({ market: choppy, settings: defaultScanner, lossToday: 0, dailyLossCap: 2000 })[0]).toMatch(/flat and choppy/);
    expect(dayBlocks({ market: choppy, settings: { ...defaultScanner, blockChoppy: false }, lossToday: 0, dailyLossCap: 2000 })).toEqual([]);
    const ok = readMarket(risingQuotes, defaultScanner);
    expect(dayBlocks({ market: ok, settings: defaultScanner, lossToday: -2500, dailyLossCap: 2000 })[0]).toMatch(/Daily loss limit/);
    expect(dayBlocks({ market: ok, settings: { ...defaultScanner, blockAfterLossLimit: false }, lossToday: -2500, dailyLossCap: 2000 })).toEqual([]);
  });
});

describe('exit help', () => {
  const pos = { symbol: 'UP', entry: 100, qty: 100, stop0: 99, stop: 99, highest: 101.5 };
  const sOff = { ...defaultScanner, exitHelp: true };

  it('at 1R says move the stop to cost, sell half and trail the rest', () => {
    const a = exitAdvice(pos, quote('UP', 101.2), climb, sOff, '15:15');
    const codes = a.map((x) => x.code);
    expect(codes).toContain('stop-to-cost');
    expect(codes).toContain('sell-half');
    expect(a.find((x) => x.code === 'stop-to-cost')!.text).toContain(costPrice(100, 100).toFixed(2));
  });

  it('does not repeat "move to cost" once the stop is already there', () => {
    const a = exitAdvice({ ...pos, stop: costPrice(100, 100) }, quote('UP', 101.2), climb, sOff, '15:15');
    expect(a.map((x) => x.code)).not.toContain('stop-to-cost');
  });

  it('gives no profit-taking advice below 1R', () => {
    const codes = exitAdvice(pos, quote('UP', 100.4), climb, sOff, '15:15').map((x) => x.code);
    expect(codes).not.toContain('sell-half');
  });

  it('warns when price loses VWAP', () => {
    const a = exitAdvice(pos, quote('FALL', 97.9), faller, sOff, '15:15');
    expect(a.map((x) => x.code)).toContain('vwap-break');
  });

  it('warns when volume dries up', () => {
    const dry = day((i) => 100 + i * 0.01, (i) => (i >= 102 ? 100 : 1000));
    expect(exitAdvice(pos, quote('X', 101), dry, sOff, '15:15').map((x) => x.code)).toContain('volume-dry');
  });

  it('warns about a bearish engulfing candle', () => {
    const cs = day((i) => 100 + i * 0.02, () => 1000);
    const n = cs.length;
    cs[n - 2] = { ...cs[n - 2], o: 101.5, c: 102.2, h: 102.3, l: 101.45 }; // green
    cs[n - 1] = { ...cs[n - 1], o: 102.3, c: 101.3, h: 102.35, l: 101.25 }; // red, engulfs it
    expect(exitAdvice(pos, quote('X', 101.4, ist(11, 0, 30)), cs, sOff, '15:15').map((x) => x.code)).toContain('reversal');
  });

  it('gives a hard square-off warning before the cut-off, and after it', () => {
    const near = exitAdvice(pos, quote('UP', 100.2, ist(15, 7)), climb, sOff, '15:15');
    expect(near.find((x) => x.code === 'square-off')!.text).toMatch(/8 minutes left/);
    const past = exitAdvice(pos, quote('UP', 100.2, ist(15, 17)), climb, sOff, '15:15');
    expect(past.find((x) => x.code === 'square-off')!.text).toMatch(/has passed/);
    expect(exitAdvice(pos, quote('UP', 100.2, ist(12, 0)), climb, sOff, '15:15').map((x) => x.code)).not.toContain('square-off');
  });
});

describe('pre-market watchlist', () => {
  const dailyFor = (high: number, vol: number): DailyInfo => ({ prevHigh: high, prevLow: 95, prevClose: 100, prevVolume: vol, avgVolume: vol });
  const pre = ist(9, 5);
  const qs = [
    quote('GAPUP', 102, pre), // +2% gap, just above yesterday's high
    quote('FLAT', 100, pre),
    quote('GAPDOWN', 97, pre),
    quote('BADNEWS', 102, pre),
    ...Array.from({ length: 20 }, (_, i) => quote(`O${i}`, 100 + i * 0.01, pre)),
  ];
  const dmap = new Map<string, DailyInfo>([
    ['GAPUP', dailyFor(101.5, 9_000_000)],
    ['FLAT', dailyFor(103, 8_000_000)],
    ['GAPDOWN', dailyFor(103, 7_000_000)],
    ['BADNEWS', dailyFor(101.5, 9_500_000)],
    ...Array.from({ length: 20 }, (_, i): [string, DailyInfo] => [`O${i}`, dailyFor(103, 100_000 + i)]),
  ]);

  it('uses the indicated price before the open and the real open after it', () => {
    expect(gapPct(quote('A', 102, ist(9, 5)))).toBeCloseTo(2, 5);
    expect(gapPct(quote('A', 99, ist(9, 30), 100, 101))).toBeCloseTo(1, 5); // after the open the opening price counts
  });

  it('ranks gap-up, liquid shares near yesterday\'s high first and explains why', async () => {
    const list = await buildWatchlist(qs, dmap, { ...defaultScanner, watchlistSize: 3 });
    expect(list).toHaveLength(3);
    expect(list[0].symbol === 'GAPUP' || list[0].symbol === 'BADNEWS').toBe(true);
    expect(list.map((x) => x.symbol)).not.toContain('GAPDOWN');
    expect(list[0].why.join(' ')).toMatch(/gapped up 2.00%/);
    expect(list[0].why.join(' ')).toMatch(/yesterday's high/);
    expect(list[0].score).toBeGreaterThan(list[2].score - 1);
  });

  it('drops shares with bad news, and adds points for good news', async () => {
    const news = async (s: string) => (s === 'BADNEWS' ? { score: -3, resultsSoon: false, headline: 'Probe launched' } : s === 'GAPUP' ? { score: 2, resultsSoon: false, headline: 'Wins big order' } : { score: 0, resultsSoon: false });
    const list = await buildWatchlist(qs, dmap, { ...defaultScanner, watchlistSize: 5 }, news);
    expect(list.map((x) => x.symbol)).not.toContain('BADNEWS');
    expect(list[0].symbol).toBe('GAPUP');
    expect(list[0].why.join(' ')).toMatch(/good news today: Wins big order/);
    const allowed = await buildWatchlist(qs, dmap, { ...defaultScanner, watchlistSize: 5, blockNearNews: false }, news);
    expect(allowed.map((x) => x.symbol)).toContain('BADNEWS');
  });

  it('works without any daily data and says what is missing', () => {
    const b = baseScore(quote('X', 101, pre), undefined, undefined);
    expect(b.why.join(' ')).toMatch(/yesterday's volume not available/);
    expect(b.why.join(' ')).toMatch(/yesterday's high and low not available/);
  });
});

describe('learning from your results', () => {
  const pick = (id: number, symbol: string, setup: SavedPick['setup'], ts: number): SavedPick => ({ id, day: '2026-11-05', ts, symbol, setup, score: 80 });
  const trade = (id: number, symbol: string, pnl: number, entryTs: number, over: Partial<TradeRow> = {}): TradeRow => ({
    id, day: '2026-11-05', mode: 'paper', symbol, qty: 10, entry_price: 100, exit_price: 101, entry_ts: entryTs, exit_ts: entryTs + 60_000,
    pattern: 'manual', entry_reason: '', exit_reason: '', charges: 1, net_pnl: pnl, ...over,
  });

  it('matches only your own paper trades, once each, bought after the pick', () => {
    const picks = [pick(1, 'AAA', 'orb', ist(10, 0)), pick(2, 'BBB', 'orb', ist(10, 0))];
    const trades = [
      trade(1, 'AAA', 50, ist(10, 5)),
      trade(2, 'BBB', 50, ist(10, 5), { pattern: 'orb15' }), // the auto trader's, not yours
      trade(3, 'AAA', 50, ist(9, 0)), // bought before the pick
    ];
    const m = matchTrades(picks, trades);
    expect([...m.keys()]).toEqual([1]);
    expect(m.get(1)!.id).toBe(1);
  });

  it('shows win rate and profit by setup and by time of day', () => {
    const picks = [pick(1, 'A', 'orb', ist(10, 0)), pick(2, 'B', 'orb', ist(10, 30)), pick(3, 'C', 'pdh', ist(13, 0)), pick(4, 'D', 'pdh', ist(13, 10))];
    const trades = [trade(1, 'A', 200, ist(10, 5)), trade(2, 'B', -100, ist(10, 40)), trade(3, 'C', -80, ist(13, 5))];
    const r = learnStats(picks, trades, defaultScanner);
    const orb = r.bySetup.find((x) => x.key === 'orb')!;
    expect(orb).toMatchObject({ picks: 2, taken: 2, wins: 1, losses: 1, winRate: 50, net: 100 });
    const pdh = r.bySetup.find((x) => x.key === 'pdh')!;
    expect(pdh).toMatchObject({ picks: 2, taken: 1, wins: 0, net: -80 });
    expect(r.byHour.map((h) => h.label)).toEqual(['10:00 to 10:59', '13:00 to 13:59']);
    expect(r.byHour[0]).toMatchObject({ taken: 2, net: 100 });
  });

  it('turns off a setup that keeps losing, only when learning is on and enough trades are in', () => {
    const picks = Array.from({ length: 6 }, (_, i) => pick(i + 1, `S${i}`, 'volume', ist(10, i)));
    const trades = picks.map((p, i) => trade(i + 1, p.symbol, i === 0 ? 10 : -50, ist(10, 30)));
    expect(learnStats(picks, trades, defaultScanner).off).toEqual([]); // learning is off by default
    const on = learnStats(picks, trades, { ...defaultScanner, learn: true, learnMinTrades: 5, learnMinWinRate: 40 });
    expect(on.off).toEqual(['volume']);
    const fewer = learnStats(picks, trades, { ...defaultScanner, learn: true, learnMinTrades: 10 });
    expect(fewer.off).toEqual([]); // not enough trades to judge yet
  });
});

describe('scanner settings', () => {
  it('is off by default, with every limit a setting', () => {
    const d = defaultSettings({ money: { capital: 50000, riskPerTrade: 500, maxOpenPositions: 5, dailyLossCap: 2000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never);
    expect(d.scanner.enabled).toBe(false);
    expect(d.scanner.exitHelp).toBe(false);
    expect(d.scanner.learn).toBe(false);
    expect(d.scanner.riskPerTrade).toBe(500);
  });

  it('checks values and times in plain words', () => {
    expect(() => validateScanner({ scanFrom: '9:20' })).toThrow(/scan from must be a time/);
    expect(() => validateScanner({ scanFrom: '15:00', scanTo: '10:00' })).toThrow(/earlier/);
    expect(() => validateScanner({ minScore: 0 })).toThrow(/minimum score/);
    expect(() => validateScanner({ minStopPct: 2, maxStopPct: 1 })).toThrow(/smaller than/);
    expect(() => validateScanner({ enabled: 'yes' })).toThrow(/on or off/);
    expect(validateScanner({ minScore: 80, scanTo: '15:00' })).toMatchObject({ minScore: 80, scanTo: '15:00', enabled: false });
    expect(validateScanner({})).toMatchObject({ requireVolume: true, minVolumeRatio: 1.2 });
    expect(() => validateScanner({ minVolumeRatio: 0.5 })).toThrow(/volume surge multiple/);
  });

  it('keeps older saved settings (no scanner block) and fills in the defaults', () => {
    const db = new Db(':memory:');
    const d = defaultSettings({ money: { capital: 50000, riskPerTrade: 500, maxOpenPositions: 5, dailyLossCap: 2000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never);
    const old = JSON.parse(JSON.stringify(d));
    delete old.scanner;
    db.setSetting('app_settings', JSON.stringify(old));
    expect(loadSettings(db, d).scanner.enabled).toBe(false);
    const on = { ...d, scanner: { ...d.scanner, enabled: true, minScore: 75 } };
    saveSettings(db, validateSettings(on));
    expect(loadSettings(db, d).scanner).toMatchObject({ enabled: true, minScore: 75 });
  });
});

describe('ScannerService', () => {
  const cfg = { money: { capital: 50000, riskPerTrade: 500, maxOpenPositions: 5, dailyLossCap: 2000, maxDayMovePctByList: { large: 3, mid: 6, small: 12 } } } as never;

  function setup(over: Partial<ReturnType<typeof defaultSettings>['scanner']> = {}, trader = { positions: new Map(), realizedToday: 0, unrealized: () => 0 }, now = T1100, candles: Candle[] = climb) {
    const store = new MarketStore();
    // 25 other shares: a few up, most flat, so the market is not "choppy"
    const others = Array.from({ length: 25 }, (_, i) => quote(`O${i}`, i < 15 ? 100.6 : 99.95, now));
    const up = quote('UP', 103, now, 100, 101); // gapped up 1%, now +3%
    store.update([...others, up]);
    store.seedCandles('UP', candles);
    const db = new Db(':memory:');
    const settings = defaultSettings(cfg);
    settings.scanner = { ...settings.scanner, enabled: true, watchlistSize: 3, ...over };
    const svc = new ScannerService({ store, db, settings: () => settings, trader, squareOffTime: () => '15:15', listKey: () => 'large', now: () => now });
    svc.setDaily(new Map([['UP', daily]]));
    return { svc, db, settings, store };
  }

  it('does nothing and saves nothing while switched off', async () => {
    const { svc, db, settings } = setup();
    settings.scanner.enabled = false;
    expect(await svc.state()).toEqual({ enabled: false });
    expect(db.scannerPicks()).toHaveLength(0);
    expect(svc.exitHelp().enabled).toBe(false);
  });

  it('builds a watchlist, scores it live and shows a pick with a full plan', async () => {
    const { svc } = setup();
    const s = await svc.state();
    expect(s.phase).toBe('scanning');
    expect(s.watchlist!.map((w) => w.symbol)).toContain('UP');
    const up = s.watchlist!.find((w) => w.symbol === 'UP')!;
    expect(up.liveScore).toBeGreaterThanOrEqual(70);
    expect(s.noTrade).toBe(false);
    const pick = s.picks![0];
    expect(pick.symbol).toBe('UP');
    expect(pick.score).toBeGreaterThanOrEqual(70);
    expect(pick.plan.stop).toBeLessThan(pick.plan.entryLow);
    expect(pick.reasons.length).toBeGreaterThan(0);
  });

  it('saves each pick once and keeps the plan', async () => {
    const { svc, db } = setup();
    await svc.state();
    await svc.state();
    const rows = db.scannerPicks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'UP', setup: 'orb' });
    expect(JSON.parse(rows[0].plan).plan.target2).toBe(rows[0].target2);
  });

  it('says NO TRADE with the reason when nothing scores enough', async () => {
    const { svc } = setup({ minScore: 100 });
    const s = await svc.state();
    expect(s.noTrade).toBe(true);
    expect(s.picks).toEqual([]);
    expect(s.noTradeWhy!.join(' ')).toMatch(/No share on the watchlist scores 100 or more/);
  });

  it('skips a breakout on thin volume, with the reason, unless the volume switch is off', async () => {
    // same climb, but the last minutes are quiet
    const quiet = day((i) => (i < 15 ? 100 + 0.2 * Math.sin(i) : 100.3 + (i - 15) * 0.03), (i) => (i >= 100 ? 200 : 1000));
    const thin = setup({ minScore: 60 }, undefined, T1100, quiet);
    const s = await thin.svc.state();
    expect(s.picks).toEqual([]);
    expect(s.skipped![0].why).toMatch(/Thin volume: the last 5 minutes are only 0.2x the day's earlier average \(you require 1.2x\)/);

    const off = setup({ requireVolume: false, minScore: 60 }, undefined, T1100, quiet);
    expect((await off.svc.state()).picks![0].symbol).toBe('UP');

    const strict = setup({ minVolumeRatio: 5 }); // the normal climb has 3x
    expect((await strict.svc.state()).picks).toEqual([]);
  });

  it('blocks everything after the daily loss limit, and when the market is choppy', async () => {
    const lost = setup({}, { positions: new Map(), realizedToday: -2500, unrealized: () => 0 });
    const s = await lost.svc.state();
    expect(s.picks).toEqual([]);
    expect(s.blocks![0]).toMatch(/Daily loss limit/);
    expect(s.noTradeWhy![0]).toMatch(/Daily loss limit/);

    const { svc, store } = setup();
    store.update(Array.from({ length: 25 }, (_, i) => quote(`O${i}`, 100.02)));
    const c = await svc.state();
    expect(c.blocks![0]).toMatch(/flat and choppy/);
    expect(c.picks).toEqual([]);
  });

  it('does not average down: a share you hold is left out and the reason is shown', async () => {
    const held = new Map([['UP', { symbol: 'UP' } as never]]);
    const { svc } = setup({}, { positions: held, realizedToday: 0, unrealized: () => 0 });
    const s = await svc.state();
    expect(s.picks).toEqual([]);
    expect(s.skipped![0]).toMatchObject({ symbol: 'UP' });
    expect(s.skipped![0].why).toMatch(/no averaging down/);
  });

  it('blocks entries in the first minutes and shows the pre-open watchlist before 09:15', async () => {
    const early = setup({}, undefined, ist(9, 17, 30));
    const e = await early.svc.state();
    expect(e.phase).toBe('waiting');
    expect(e.picks).toEqual([]);

    const pre = setup({}, undefined, ist(9, 5));
    const p = await pre.svc.state();
    expect(p.phase).toBe('pre-open');
    expect(p.watchlist!.length).toBeGreaterThan(0);
    expect(p.picks).toEqual([]);
  });

  it('turns off a setup that keeps losing for you (when learning is on)', async () => {
    const { svc, db } = setup({ learn: true, learnMinTrades: 2, learnMinWinRate: 50 });
    for (let i = 0; i < 3; i++) {
      db.addScannerPick({ day: `2026-10-0${i + 1}`, ts: ist(10, 0) - (i + 1) * 86_400_000, symbol: `L${i}`, setup: 'orb', score: 80, entry: 100, stop: 99, target1: 101, target2: 102, qty: 10, plan: '{}' });
      db.addTrade({ day: `2026-10-0${i + 1}`, mode: 'paper', symbol: `L${i}`, qty: 10, entry_price: 100, exit_price: 99, entry_ts: ist(10, 5) - (i + 1) * 86_400_000, exit_ts: ist(10, 9) - (i + 1) * 86_400_000, pattern: 'manual', entry_reason: '', exit_reason: '', charges: 1, net_pnl: -20 });
    }
    const s = await svc.state();
    expect(s.disabledSetups).toEqual(['orb']);
    expect(s.picks).toEqual([]);
    expect(s.skipped![0].why).toMatch(/turned off/);
    expect(svc.stats()!.bySetup.find((r) => r.key === 'orb')!.off).toBe(true);
  });

  it('gives exit help only when it is switched on', async () => {
    const pos = { symbol: 'UP', entry: 100, qty: 100, stop0: 99, stop: 99, highest: 102, entryTs: 0, mode: 'paper', marginUsed: 0, pattern: 'manual', reason: '', orderId: '', estimated: false } as never;
    const { svc, settings } = setup({}, { positions: new Map([['UP', pos]]), realizedToday: 0, unrealized: () => 0 });
    expect(svc.exitHelp().enabled).toBe(false);
    settings.scanner.exitHelp = true;
    const h = svc.exitHelp();
    expect(h.enabled).toBe(true);
    expect(h.items[0].alerts.map((a) => a.code)).toContain('sell-half');
  });
});

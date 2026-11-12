import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { defaultScanner, type ScannerSettings } from './scanner/types.ts';
import { defaultQuality, type QualityRules } from './trading/quality.ts';
import type { UniverseId } from './universe/index.ts';

/** Limits that differ for each share list (large / mid / small cap). */
export interface ListRules {
  /** Skip shares that already moved more than this % today */
  maxDayMovePct: number;
  /** Most rupees you accept to lose on one trade (incl. charges) */
  riskPerTrade: number;
  maxOpenPositions: number;
  /** Profit target for every auto entry, % above the buy price (minimum 0.75) */
  targetPct: number;
  /** Widest stop loss allowed, % below the buy price. A pattern whose natural stop is wider is skipped */
  stopLossPct: number;
  /** Entry checks that differ for this list. Anything left out uses the "Entry checks" for all lists */
  checks: Partial<EntryChecks>;
}

/**
 * Starting entry checks per list. Large caps are smooth and liquid: a lower volume surge is enough, but price must not
 * be stretched. Mid and small caps are noisier: they need a stronger volume surge, a stronger trend (ADX), a wider
 * ATR stop and more room for the stretch, or normal swings knock them out.
 */
export const LIST_CHECKS: Record<UniverseId, Partial<EntryChecks>> = {
  large: { minScore: 70, minVolumeRatio: 1.3, maxStretchPct: 0.5, minAdx: 18, atrStopMult: 1.2 },
  mid: { minScore: 72, minVolumeRatio: 1.6, maxStretchPct: 0.8, minAdx: 20, atrStopMult: 1.5 },
  small: { minScore: 75, minVolumeRatio: 2, maxStretchPct: 1.2, minAdx: 22, atrStopMult: 1.8 },
};

/** Starting target / stop per list: bigger moves and noise in mid and small caps need more room. */
export const LIST_TARGETS: Record<UniverseId, { targetPct: number; stopLossPct: number }> = {
  large: { targetPct: 1, stopLossPct: 1 },
  mid: { targetPct: 1.5, stopLossPct: 1.5 },
  small: { targetPct: 2.5, stopLossPct: 2 },
};

export interface AppSettings {
  lists: Record<UniverseId, ListRules>;
  dailyLossCap: number;
  /** Paper money to trade with, ₹. Only used in paper mode */
  paperCash: number;
  /** Your own money (margin) put into each auto trade, ₹. Upstox leverage multiplies it (about 5x). 0 = size by risk per trade */
  capitalPerTrade: number;
  /** Most new auto trades opened in one minute (stops a burst of entries on the same market move) */
  entriesPerMinute: number;
  /** Buy only when price is above today's VWAP (average traded price) */
  requireAboveVwap: boolean;
  /** Skip shares with bad news or results coming */
  newsFilter: boolean;
  /** Extra entry checks: trend (EMA9>EMA21), RSI, not chasing, time window, weak-market stop, reward-to-risk */
  qualityGate: boolean;
  /** Target must be at least this many times the stop distance */
  minRewardRisk: number;
  /** Intraday short selling (sell first, buy back later). Paper only, off by default */
  shortSelling: boolean;
  /** Three close targets from the calculated stop (multiples of the risk). Target 1: stop to break-even. Target 2: stop to target 1. Target 3: sell */
  exitPlan: { enabled: boolean; t1: number; t2: number; t3: number };
  /** Every new auto trade gets at least this wide a stop, % below the entry (above for a short). Tight stops get hit by normal noise */
  minStopWidthPct: number;
  /** Stricter entry checks. Each one is a number; 0 turns that check off */
  entryChecks: EntryChecks;
  /** The "Best trades now" scanner (off by default) */
  scanner: ScannerSettings;
}

export interface EntryChecks {
  /** Pattern score needed (0-100) */
  minScore: number;
  /** The signal candle's volume must be this many times the recent average */
  minVolumeRatio: number;
  /** Stops tighter than this % are noise: skip */
  minStopPct: number;
  /** Do not buy more than this % above EMA9 (chasing) */
  maxStretchPct: number;
  /** The signal candle must close in the top (bottom for a short) part of its range, 0-1 (0.6 = top 40%) */
  candleStrength: number;
  /** Skip when today's high (low for a short) is closer than this many times target 1: no room to run */
  roomToTarget: number;
  /** EMA21 must be rising (falling for a short) over the last 5 candles: 1 = on, 0 = off */
  trendSlope: number;
  /** Trend strength (ADX) needed, 0-60. 0 = off */
  minAdx: number;
  /** MACD histogram must agree with the trade: 1 = on, 0 = off */
  macdConfirm: number;
  /** Price on the right side of EMA50: 1 = on, 0 = off */
  slowTrend: number;
  /** Stop at least this many ATRs wide, 0 = off */
  atrStopMult: number;
}

export const defaultEntryChecks: EntryChecks = { minScore: 70, minVolumeRatio: 1.3, minStopPct: 0.25, maxStretchPct: 0.6, candleStrength: 0.6, roomToTarget: 0.8, trendSlope: 1, minAdx: 18, macdConfirm: 1, slowTrend: 1, atrStopMult: 1.2 };

/** The quality rules the trader uses for one list: global checks, then that list's own, plus targets and stop limits. */
export function qualityFor(s: AppSettings, id: UniverseId): QualityRules {
  return { ...defaultQuality, enabled: s.qualityGate, targetPct: effectiveTargetPct(s, id), stopLossPct: s.lists[id].stopLossPct, minRewardRisk: s.minRewardRisk, ...s.entryChecks, ...s.lists[id].checks, t1: s.exitPlan.enabled ? s.exitPlan.t1 : 0 };
}

/** Target % used for auto entries: none while the staged targets are on (they come from each trade's own stop). */
export const effectiveTargetPct = (s: AppSettings, id: UniverseId): number => (s.exitPlan.enabled ? 0 : s.lists[id].targetPct);

export function defaultSettings(c: Config): AppSettings {
  const m = c.money;
  return {
    lists: {
      large: { maxDayMovePct: m.maxDayMovePctByList.large, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, ...LIST_TARGETS.large, checks: { ...LIST_CHECKS.large } },
      mid: { maxDayMovePct: m.maxDayMovePctByList.mid, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, ...LIST_TARGETS.mid, checks: { ...LIST_CHECKS.mid } },
      small: { maxDayMovePct: m.maxDayMovePctByList.small, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, ...LIST_TARGETS.small, checks: { ...LIST_CHECKS.small } },
    },
    dailyLossCap: m.dailyLossCap,
    paperCash: m.capital,
    capitalPerTrade: 20_000,
    entriesPerMinute: 2,
    requireAboveVwap: true,
    newsFilter: true,
    qualityGate: true,
    minRewardRisk: 1.5,
    shortSelling: true,
    exitPlan: { enabled: true, t1: 1, t2: 1.75, t3: 2.5 },
    minStopWidthPct: 0.6,
    entryChecks: { ...defaultEntryChecks },
    scanner: { ...defaultScanner, riskPerTrade: m.riskPerTrade },
  };
}

const IDS: UniverseId[] = ['large', 'mid', 'small'];

function inRange(name: string, v: unknown, lo: number, hi: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < lo || v > hi) throw new Error(`${name} must be between ${lo} and ${hi}`);
  if (integer && !Number.isInteger(v)) throw new Error(`${name} must be a whole number`);
  return v;
}

/** Checks a full settings object from the app. Throws a plain-words error when something is off. */
export function validateSettings(input: unknown): AppSettings {
  const s = input as Partial<AppSettings> | null;
  if (!s || typeof s !== 'object' || !s.lists) throw new Error('Settings are missing');
  const lists = {} as Record<UniverseId, ListRules>;
  for (const id of IDS) {
    const r = s.lists[id];
    if (!r) throw new Error(`Settings for ${id} cap are missing`);
    lists[id] = {
      maxDayMovePct: inRange(`${id}: day-move limit %`, r.maxDayMovePct, 0.5, 30),
      riskPerTrade: inRange(`${id}: risk per trade`, r.riskPerTrade, 10, 100_000),
      maxOpenPositions: inRange(`${id}: max open positions`, r.maxOpenPositions, 1, 20, true),
      // Older saved settings do not have these: use the starting values for that list.
      targetPct: r.targetPct === undefined ? LIST_TARGETS[id].targetPct : inRange(`${id}: profit target %`, r.targetPct, 0.75, 10),
      stopLossPct: r.stopLossPct === undefined ? LIST_TARGETS[id].stopLossPct : inRange(`${id}: stop loss %`, r.stopLossPct, 0.2, 5),
      checks: validateChecks(id, r.checks),
    };
  }
  if (typeof s.requireAboveVwap !== 'boolean' || typeof s.newsFilter !== 'boolean') throw new Error('Filters must be on or off');
  return {
    lists,
    dailyLossCap: inRange('daily loss cap', s.dailyLossCap, 50, 1_000_000),
    // Older saved settings do not have this: fall back to a normal starting amount.
    paperCash: s.paperCash === undefined ? 50_000 : inRange('paper cash', s.paperCash, 1000, 100_000_000),
    capitalPerTrade: s.capitalPerTrade === undefined ? 20_000 : s.capitalPerTrade === 0 ? 0 : inRange('capital per trade', s.capitalPerTrade, 1000, 10_000_000),
    entriesPerMinute: s.entriesPerMinute === undefined ? 2 : inRange('new trades per minute', s.entriesPerMinute, 1, 20, true),
    requireAboveVwap: s.requireAboveVwap,
    newsFilter: s.newsFilter,
    // Older saved settings do not have these yet: use the defaults instead of throwing them away.
    qualityGate: typeof s.qualityGate === 'boolean' ? s.qualityGate : true,
    minRewardRisk: s.minRewardRisk === undefined ? 1.5 : inRange('reward-to-risk', s.minRewardRisk, 1, 5),
    shortSelling: bool('short selling', s.shortSelling, true),
    exitPlan: validateExitPlan(s.exitPlan),
    minStopWidthPct: num('minimum stop width %', s.minStopWidthPct, 0.6, 0.1, 5),
    entryChecks: validateEntryChecks(s.entryChecks),
    scanner: validateScanner(s.scanner),
  };
}

function validateExitPlan(input: unknown): AppSettings['exitPlan'] {
  const l = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out = {
    enabled: bool('staged targets on/off', l.enabled, true),
    t1: num('target 1 (x risk)', l.t1, 1, 0.5, 5),
    t2: num('target 2 (x risk)', l.t2, 1.5, 0.5, 8),
    t3: num('target 3 (x risk)', l.t3, 2, 0.5, 10),
  };
  if (!(out.t1 < out.t2 && out.t2 < out.t3)) throw new Error('Targets must go up: target 1 < target 2 < target 3');
  return out;
}

function validateEntryChecks(input: unknown): EntryChecks {
  const l = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const d = defaultEntryChecks;
  return {
    minScore: num('minimum score', l.minScore, d.minScore, 0, 100),
    minVolumeRatio: num('volume vs average', l.minVolumeRatio, d.minVolumeRatio, 0, 10),
    minStopPct: num('smallest stop %', l.minStopPct, d.minStopPct, 0, 3),
    maxStretchPct: num('most above EMA9 %', l.maxStretchPct, d.maxStretchPct, 0, 5),
    candleStrength: num('candle strength', l.candleStrength, d.candleStrength, 0, 0.95),
    roomToTarget: num('room to target 1', l.roomToTarget, d.roomToTarget, 0, 5),
    trendSlope: num('trend slope check', l.trendSlope, d.trendSlope, 0, 1, true),
    minAdx: num('trend strength (ADX)', l.minAdx, d.minAdx, 0, 60),
    macdConfirm: num('MACD check', l.macdConfirm, d.macdConfirm, 0, 1, true),
    slowTrend: num('slow trend check', l.slowTrend, d.slowTrend, 0, 1, true),
    atrStopMult: num('ATR stop multiple', l.atrStopMult, d.atrStopMult, 0, 5),
  };
}

/** One list's own entry checks. Anything missing (older saved settings) takes the starting value for that list. */
function validateChecks(id: UniverseId, input: unknown): Partial<EntryChecks> {
  const l = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const start = { ...defaultEntryChecks, ...LIST_CHECKS[id] };
  const all = validateEntryChecks({ ...start, ...l });
  const out: Partial<EntryChecks> = {};
  for (const k of Object.keys(LIST_CHECKS[id]) as Array<keyof EntryChecks>) out[k] = all[k];
  return out;
}

const bool = (name: string, v: unknown, fallback: boolean): boolean => {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error(`${name} must be on or off`);
  return v;
};

const hhmm = (name: string, v: unknown, fallback: string): string => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${name} must be a time like 09:20`);
  return v;
};

const num = (name: string, v: unknown, fallback: number, lo: number, hi: number, integer = false): number =>
  v === undefined ? fallback : inRange(name, v, lo, hi, integer);

/** Checks the scanner settings. Anything missing (older saved settings) takes its default. */
export function validateScanner(input: unknown, base: ScannerSettings = defaultScanner): ScannerSettings {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: ScannerSettings = {
    enabled: bool('scanner on/off', s.enabled, base.enabled),
    watchlistSize: num('watchlist size', s.watchlistSize, base.watchlistSize, 3, 50, true),
    minScore: num('minimum score', s.minScore, base.minScore, 1, 100),
    scanFrom: hhmm('scan from', s.scanFrom, base.scanFrom),
    scanTo: hhmm('scan to', s.scanTo, base.scanTo),
    noEntryFirstMinutes: num('no entries in the first minutes', s.noEntryFirstMinutes, base.noEntryFirstMinutes, 0, 60, true),
    riskPerTrade: num('scanner risk per trade', s.riskPerTrade, base.riskPerTrade, 10, 100_000),
    atrStopMult: num('ATR stop multiple', s.atrStopMult, base.atrStopMult, 1, 3),
    minStopPct: num('minimum stop %', s.minStopPct, base.minStopPct, 0.1, 5),
    maxStopPct: num('widest stop %', s.maxStopPct, base.maxStopPct, 0.2, 10),
    chopMovePct: num('flat market %', s.chopMovePct, base.chopMovePct, 0.02, 2),
    requireVolume: bool('require a volume surge', s.requireVolume, base.requireVolume),
    minVolumeRatio: num('volume surge multiple', s.minVolumeRatio, base.minVolumeRatio, 1, 10),
    blockChoppy: bool('block choppy market', s.blockChoppy, base.blockChoppy),
    blockNearNews: bool('block near news', s.blockNearNews, base.blockNearNews),
    blockAfterLossLimit: bool('block after loss limit', s.blockAfterLossLimit, base.blockAfterLossLimit),
    blockAveraging: bool('block averaging down', s.blockAveraging, base.blockAveraging),
    exitHelp: bool('exit help', s.exitHelp, base.exitHelp),
    squareOffWarnMin: num('square-off warning minutes', s.squareOffWarnMin, base.squareOffWarnMin, 1, 60, true),
    learn: bool('learning', s.learn, base.learn),
    learnMinTrades: num('trades before judging a setup', s.learnMinTrades, base.learnMinTrades, 1, 1000, true),
    learnMinWinRate: num('lowest win rate %', s.learnMinWinRate, base.learnMinWinRate, 0, 100),
  };
  if (out.minStopPct >= out.maxStopPct) throw new Error('The minimum stop % must be smaller than the widest stop %');
  if (out.scanFrom >= out.scanTo) throw new Error('Scan from must be earlier than scan to');
  return out;
}

const KEY = 'app_settings';

export function loadSettings(db: Db, defaults: AppSettings): AppSettings {
  const raw = db.getSetting(KEY);
  if (!raw) return defaults;
  try {
    return validateSettings(JSON.parse(raw));
  } catch {
    return defaults; // bad saved data: fall back to .env defaults rather than crash
  }
}

export function saveSettings(db: Db, s: AppSettings): void {
  db.setSetting(KEY, JSON.stringify(s));
}

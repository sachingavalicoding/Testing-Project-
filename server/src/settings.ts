import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { UniverseId } from './universe/index.ts';

/** Limits that differ for each share list (large / mid / small cap). */
export interface ListRules {
  /** Skip shares that already moved more than this % today */
  maxDayMovePct: number;
  /** Most rupees you accept to lose on one trade (incl. charges) */
  riskPerTrade: number;
  maxOpenPositions: number;
  /** Paper fills are made worse by this % so paper results are honest (real fills slip too) */
  slippagePct: number;
}

export interface AppSettings {
  lists: Record<UniverseId, ListRules>;
  dailyLossCap: number;
  /** Buy only when price is above today's VWAP (average traded price) */
  requireAboveVwap: boolean;
  /** Skip shares with bad news or results coming */
  newsFilter: boolean;
}

export function defaultSettings(c: Config): AppSettings {
  const m = c.money;
  return {
    lists: {
      large: { maxDayMovePct: m.maxDayMovePctByList.large, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, slippagePct: 0.05 },
      mid: { maxDayMovePct: m.maxDayMovePctByList.mid, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, slippagePct: 0.1 },
      small: { maxDayMovePct: m.maxDayMovePctByList.small, riskPerTrade: m.riskPerTrade, maxOpenPositions: m.maxOpenPositions, slippagePct: 0.3 },
    },
    dailyLossCap: m.dailyLossCap,
    requireAboveVwap: true,
    newsFilter: true,
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
      slippagePct: inRange(`${id}: paper slippage %`, r.slippagePct, 0, 2),
    };
  }
  if (typeof s.requireAboveVwap !== 'boolean' || typeof s.newsFilter !== 'boolean') throw new Error('Filters must be on or off');
  return {
    lists,
    dailyLossCap: inRange('daily loss cap', s.dailyLossCap, 50, 1_000_000),
    requireAboveVwap: s.requireAboveVwap,
    newsFilter: s.newsFilter,
  };
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

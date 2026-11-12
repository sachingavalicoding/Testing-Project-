export interface Mover { symbol: string; ltp: number; changePct: number; volume: number }
export interface Position {
  symbol: string; mode: string; qty: number; entry: number; stop: number; highest: number;
  pattern: string; reason: string; ltp: number; pnl: number; estimated: boolean; target?: number;
  /** Auto entries: prices of target 1, 2, 3 and how many were reached. Target 1: stop to break-even. Target 2: stop to target 1 */
  targets?: number[]; stage?: number; stop0?: number;
  /** 'short' = sold first, to be bought back. Missing means long */
  side?: 'long' | 'short';
  /** What closing now would cost in charges. pnl is before charges, like a broker's screen */
  charges?: number;
}
export interface PendingOrder { id: string; symbol: string; qty: number; limitPrice: number; stopPrice?: number; stopPct?: number; targetPrice?: number; mode: string }
export interface Quote { symbol: string; ltp: number; prevClose: number; open: number; high: number; low: number; volume: number; ts: number }
export interface Status {
  mode: 'paper' | 'real';
  running: boolean;
  haltedReason?: string;
  realAllowed: boolean;
  realizedToday: number;
  /** Open profit or loss before charges (like a broker) */
  unrealized: number;
  /** Open profit or loss after the charges of closing now (what the loss cap counts) */
  unrealizedNet?: number;
  /** Short selling is switched on in Settings */
  allowShort?: boolean;
  /** ...and possible right now (paper mode only) */
  canShort?: boolean;
  freeCash: number;
  positions: Position[];
  pending?: PendingOrder[];
  rules: { capital: number; dailyLossCap: number; maxOpenPositions: number; riskPerTrade: number; maxDayMovePct: number; squareOffTime: string };
  feed?: string;
  feedError?: string;
  upstoxLoggedIn?: boolean;
  realConfirmText?: string;
}
export interface Trade {
  id: number; day: string; mode: string; symbol: string; qty: number; entry_price: number; exit_price: number;
  entry_ts: number; exit_ts: number; pattern: string; entry_reason: string; exit_reason: string; charges: number; net_pnl: number;
  side?: 'long' | 'short';
}
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface EventRow { id: number; ts: number; level: string; message: string }

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json() as Promise<T>;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error ?? r.statusText);
  return json as T;
}

export const rupee = (n: number) =>
  `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export interface EntryChecks { minScore: number; minVolumeRatio: number; minStopPct: number; maxStretchPct: number; candleStrength: number; roomToTarget: number; trendSlope: number; minAdx: number; macdConfirm: number; slowTrend: number; atrStopMult: number }
export interface ListRules { maxDayMovePct: number; riskPerTrade: number; maxOpenPositions: number; targetPct: number; stopLossPct: number; checks: Partial<EntryChecks> }
export interface AppSettings {
  lists: Record<'large' | 'mid' | 'small', ListRules>;
  dailyLossCap: number;
  shortSelling: boolean;
  paperCash: number;
  capitalPerTrade: number;
  entriesPerMinute: number;
  requireAboveVwap: boolean;
  newsFilter: boolean;
  qualityGate: boolean;
  minRewardRisk: number;
  exitPlan: { enabled: boolean; t1: number; t2: number; t3: number };
  minStopWidthPct: number;
  entryChecks: EntryChecks;
  scanner: ScannerSettings;
}
export interface ScannerSettings {
  enabled: boolean; watchlistSize: number; minScore: number; scanFrom: string; scanTo: string; noEntryFirstMinutes: number;
  riskPerTrade: number; atrStopMult: number; minStopPct: number; maxStopPct: number; chopMovePct: number;
  requireVolume: boolean; minVolumeRatio: number; blockChoppy: boolean; blockNearNews: boolean; blockAfterLossLimit: boolean; blockAveraging: boolean;
  exitHelp: boolean; squareOffWarnMin: number; learn: boolean; learnMinTrades: number; learnMinWinRate: number;
}
export interface ScorePart { key: string; label: string; points: number; max: number; note: string }
export interface TradePlan {
  entryLow: number; entryHigh: number; stop: number; stopPct: number; stopHow: string; target1: number; target2: number;
  rr1: number; rr2: number; qty: number; positionValue: number; riskAfterCharges: number; gain1AfterCharges: number; gain2AfterCharges: number;
  atr: number; invalidIf: string[];
}
export interface ScannerPick { symbol: string; ltp: number; changePct: number; score: number; setup: string; setupLabel: string; parts: ScorePart[]; plan: TradePlan; reasons: string[] }
export interface WatchItem { symbol: string; ltp: number; gapPct: number; score: number; why: string[]; liveScore?: number; setup?: string }
export interface ScannerState {
  enabled: boolean; phase?: string; phaseText?: string; market?: { text: string; choppy: boolean };
  blocks?: string[]; noTrade?: boolean; noTradeWhy?: string[]; watchlist?: WatchItem[]; watchNote?: string;
  picks?: ScannerPick[]; skipped?: { symbol: string; score: number; why: string }[]; disabledSetups?: string[];
}
export interface ExitAlert { level: 'info' | 'warn' | 'act'; code: string; text: string }
export interface ExitHelp { enabled: boolean; items: { symbol: string; entry: number; ltp: number; qty: number; stop: number; alerts: ExitAlert[] }[] }
export interface LearnRow { key: string; label: string; picks: number; taken: number; wins: number; losses: number; winRate: number; net: number; off?: boolean }
export interface LearnStats { bySetup: LearnRow[]; byHour: LearnRow[]; off: string[] }

export interface Pick {
  symbol: string; ltp: number; changePct: number; aboveVwap?: boolean;
  signals: { pattern: string; reason: string; score: number; stopPct: number }[];
  news?: { score: number; resultsSoon: boolean; headlines: { title: string; source: string; link: string; ts: number }[] };
  verdict: 'buy' | 'watch' | 'avoid'; why: string; score: number;
}

export async function del<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'DELETE' });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error ?? r.statusText);
  return json as T;
}

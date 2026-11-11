/** Everything about the "Best trades now" scanner that you can change. Off by default. */
export interface ScannerSettings {
  /** Master switch. Off: no scanning, no picks, nothing saved */
  enabled: boolean;
  /** How many shares make the day's watchlist */
  watchlistSize: number;
  /** Show only shares scoring at least this (out of 100) */
  minScore: number;
  /** IST times the live scan runs between */
  scanFrom: string;
  scanTo: string;
  /** No entries in the first minutes after the 09:15 open */
  noEntryFirstMinutes: number;
  /** Most rupees you accept to lose on one planned trade, charges included */
  riskPerTrade: number;
  /** Stop distance as a multiple of the 5-minute ATR (between 1 and 1.5 is typical) */
  atrStopMult: number;
  /** Stop is never closer than this % to the entry (very tight stops get hit by noise and costs) */
  minStopPct: number;
  /** No plan if the stop would have to be wider than this % */
  maxStopPct: number;
  /** Market-flat check: median share inside +/- this % today counts as flat */
  chopMovePct: number;
  /** Block entries when the market looks choppy (flat) */
  blockChoppy: boolean;
  /** Block shares with bad news or results in the last 2 days */
  blockNearNews: boolean;
  /** Block new picks after today's loss reached your daily loss cap */
  blockAfterLossLimit: boolean;
  /** Block a share you already hold (no averaging down) */
  blockAveraging: boolean;
  /** Show exit help (move stop to cost, sell half, trail, warnings) for open positions */
  exitHelp: boolean;
  /** Warn this many minutes before the square-off time */
  squareOffWarnMin: number;
  /** Turn off setups that keep losing for you (judged on your own paper trades) */
  learn: boolean;
  /** A setup is judged only after this many of your trades */
  learnMinTrades: number;
  /** ... and turned off below this win rate % */
  learnMinWinRate: number;
}

export const defaultScanner: ScannerSettings = {
  enabled: false,
  watchlistSize: 10,
  minScore: 70,
  scanFrom: '09:20',
  scanTo: '14:30',
  noEntryFirstMinutes: 5,
  riskPerTrade: 500,
  atrStopMult: 1.5,
  minStopPct: 0.4,
  maxStopPct: 1.5,
  chopMovePct: 0.15,
  blockChoppy: true,
  blockNearNews: true,
  blockAfterLossLimit: true,
  blockAveraging: true,
  exitHelp: false,
  squareOffWarnMin: 10,
  learn: false,
  learnMinTrades: 5,
  learnMinWinRate: 40,
};

/** What a share's history looked like before today (from the broker's daily candles). */
export interface DailyInfo {
  prevHigh: number;
  prevLow: number;
  prevClose: number;
  prevVolume: number;
  /** Average daily volume over the earlier days we have */
  avgVolume: number;
}

export type Setup = 'orb' | 'pdh' | 'volume' | 'trend';

export const SETUP_LABELS: Record<Setup, string> = {
  orb: 'Opening range breakout',
  pdh: 'Previous day high breakout',
  volume: 'Volume surge',
  trend: 'Trend above VWAP',
};

export interface ScorePart {
  key: 'trend' | 'volume' | 'breakout' | 'momentum' | 'strength';
  label: string;
  points: number;
  max: number;
  /** Plain words: what was seen */
  note: string;
}

export interface ScoreResult {
  score: number;
  parts: ScorePart[];
  setup: Setup;
}

export interface TradePlan {
  side: 'BUY';
  entryLow: number;
  entryHigh: number;
  stop: number;
  stopPct: number;
  /** How the stop was chosen, in words */
  stopHow: string;
  target1: number;
  target2: number;
  /** Reward to risk at target 1 and target 2, before charges */
  rr1: number;
  rr2: number;
  qty: number;
  positionValue: number;
  /** Rupees lost if the stop is hit, charges included */
  riskAfterCharges: number;
  /** Rupees gained at target 1 / target 2, charges included */
  gain1AfterCharges: number;
  gain2AfterCharges: number;
  atr: number;
  invalidIf: string[];
}

export interface ScannerPick {
  symbol: string;
  ltp: number;
  changePct: number;
  score: number;
  setup: Setup;
  setupLabel: string;
  parts: ScorePart[];
  plan: TradePlan;
  /** Plain-words reasons to take it */
  reasons: string[];
  /** The scanner would not show this one when a block is on (kept for the "why not" list) */
  blocked?: string;
}

export interface WatchItem {
  symbol: string;
  ltp: number;
  /** % gap of the open (or the pre-open price before 09:15) from yesterday's close */
  gapPct: number;
  prevVolume?: number;
  /** % distance of price above (+) or below (-) yesterday's high */
  fromPrevHighPct?: number;
  /** % distance of price above (+) or below (-) yesterday's low */
  fromPrevLowPct?: number;
  newsScore?: number;
  newsHeadline?: string;
  score: number;
  /** Plain-words why it is on the list */
  why: string[];
}

export interface ExitAlert {
  level: 'info' | 'warn' | 'act';
  code: 'stop-to-cost' | 'sell-half' | 'trail' | 'vwap-break' | 'volume-dry' | 'reversal' | 'square-off';
  text: string;
}

export interface LearnRow {
  key: string;
  label: string;
  picks: number;
  taken: number;
  wins: number;
  losses: number;
  winRate: number;
  net: number;
  off?: boolean;
}

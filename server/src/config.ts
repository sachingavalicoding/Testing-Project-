// All settings come from environment variables (see ../../.env.example).
// Secrets never live in code.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export type FeedKind = 'upstox' | 'mock';

export interface Config {
  port: number;
  dbPath: string;
  feed: FeedKind;
  upstox: {
    apiKey: string;
    apiSecret: string;
    redirectUri: string;
    accessToken: string;
  };
  money: {
    capital: number;
    dailyLossCap: number;
    maxOpenPositions: number;
    riskPerTrade: number;
    maxDayMovePct: number;
    squareOffTime: string; // "HH:MM" IST
  };
  /** Hard lock. When false the server refuses to place any real order. */
  realTradingEnabled: boolean;
}

export function loadConfig(): Config {
  const feed = str('FEED', 'mock');
  if (feed !== 'upstox' && feed !== 'mock') throw new Error(`FEED must be "upstox" or "mock"`);
  return {
    port: num('PORT', 8080),
    dbPath: str('DB_PATH', './data/stock-iq.db'),
    feed,
    upstox: {
      apiKey: str('UPSTOX_API_KEY'),
      apiSecret: str('UPSTOX_API_SECRET'),
      redirectUri: str('UPSTOX_REDIRECT_URI', 'http://localhost:8080/api/auth/upstox/callback'),
      accessToken: str('UPSTOX_ACCESS_TOKEN'),
    },
    money: {
      capital: num('CAPITAL', 30000),
      dailyLossCap: num('DAILY_LOSS_CAP', 600),
      maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
      riskPerTrade: num('RISK_PER_TRADE', 200),
      maxDayMovePct: num('MAX_DAY_MOVE_PCT', 3),
      squareOffTime: str('SQUARE_OFF_TIME', '15:15'),
    },
    realTradingEnabled: str('REAL_TRADING_ENABLED', 'false').toLowerCase() === 'true',
  };
}

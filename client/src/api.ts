export interface Mover { symbol: string; ltp: number; changePct: number; volume: number }
export interface Position {
  symbol: string; mode: string; qty: number; entry: number; stop: number; highest: number;
  pattern: string; reason: string; ltp: number; pnl: number; estimated: boolean;
}
export interface Status {
  mode: 'paper' | 'real';
  running: boolean;
  haltedReason?: string;
  realAllowed: boolean;
  realizedToday: number;
  unrealized: number;
  freeCash: number;
  positions: Position[];
  rules: { capital: number; dailyLossCap: number; maxOpenPositions: number; riskPerTrade: number; maxDayMovePct: number; squareOffTime: string };
  feed?: string;
  feedError?: string;
  upstoxLoggedIn?: boolean;
  realConfirmText?: string;
}
export interface Trade {
  id: number; day: string; mode: string; symbol: string; qty: number; entry_price: number; exit_price: number;
  entry_ts: number; exit_ts: number; pattern: string; entry_reason: string; exit_reason: string; charges: number; net_pnl: number;
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

export interface ListRules { maxDayMovePct: number; riskPerTrade: number; maxOpenPositions: number; slippagePct: number }
export interface AppSettings {
  lists: Record<'large' | 'mid' | 'small', ListRules>;
  dailyLossCap: number;
  requireAboveVwap: boolean;
  newsFilter: boolean;
}
export interface Pick {
  symbol: string; ltp: number; changePct: number; aboveVwap?: boolean;
  signals: { pattern: string; reason: string; score: number; stopPct: number }[];
  news?: { score: number; resultsSoon: boolean; headlines: { title: string; source: string; link: string; ts: number }[] };
  verdict: 'buy' | 'watch' | 'avoid'; why: string; score: number;
}

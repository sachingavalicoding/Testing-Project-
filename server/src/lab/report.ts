import type { TradeRow } from '../db/db.ts';
import { istMinutes } from '../market/time.ts';

export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  /** 0-100 */
  winRate: number;
  /** After charges */
  net: number;
  avgWin: number;
  avgLoss: number;
  /** Gross profit divided by gross loss. Above 1 makes money. Infinity shows as null in JSON, so it is capped at 99 */
  profitFactor: number;
  /** Average rupees per trade */
  expectancy: number;
  charges: number;
}

export interface Report {
  total: Bucket;
  byPattern: Bucket[];
  bySide: Bucket[];
  byHour: Bucket[];
  byExit: Bucket[];
  bySymbol: Bucket[];
  byDay: Bucket[];
  /** Plain-words findings, most important first */
  findings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function bucketOf(key: string, rows: TradeRow[]): Bucket {
  const wins = rows.filter((t) => t.net_pnl > 0);
  const losses = rows.filter((t) => t.net_pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.net_pnl, 0);
  const gl = -losses.reduce((a, t) => a + t.net_pnl, 0);
  const net = rows.reduce((a, t) => a + t.net_pnl, 0);
  return {
    key,
    trades: rows.length,
    wins: wins.length,
    winRate: rows.length ? r2((wins.length / rows.length) * 100) : 0,
    net: r2(net),
    avgWin: wins.length ? r2(gw / wins.length) : 0,
    avgLoss: losses.length ? r2(-gl / losses.length) : 0,
    profitFactor: gl > 0 ? r2(Math.min(99, gw / gl)) : gw > 0 ? 99 : 0,
    expectancy: rows.length ? r2(net / rows.length) : 0,
    charges: r2(rows.reduce((a, t) => a + (t.charges ?? 0), 0)),
  };
}

function group(rows: TradeRow[], keyOf: (t: TradeRow) => string): Bucket[] {
  const m = new Map<string, TradeRow[]>();
  for (const t of rows) {
    const k = keyOf(t);
    (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  }
  return [...m.entries()].map(([k, v]) => bucketOf(k, v)).sort((a, b) => b.net - a.net);
}

/** How a trade ended, in a few plain groups. */
export function exitKind(reason: string): string {
  const r = reason.toLowerCase();
  if (r.startsWith('target')) return 'Target hit';
  if (r.startsWith('stop')) return 'Stop hit';
  if (r.includes('square-off')) return 'Square-off';
  if (r.includes('kill') || r.includes('loss cap')) return 'Kill all / loss cap';
  if (r.includes('manual')) return 'Manual';
  return 'Other';
}

export function buildReport(trades: TradeRow[]): Report {
  const total = bucketOf('All trades', trades);
  const byPattern = group(trades, (t) => t.pattern);
  const bySide = group(trades, (t) => ((t.side ?? 'long') === 'short' ? 'Short' : 'Buy'));
  const byHour = group(trades, (t) => {
    const m = istMinutes(t.entry_ts);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:00`;
  }).sort((a, b) => a.key.localeCompare(b.key));
  const byExit = group(trades, (t) => exitKind(t.exit_reason));
  const bySymbol = group(trades, (t) => t.symbol);
  const byDay = group(trades, (t) => t.day).sort((a, b) => a.key.localeCompare(b.key));

  const findings: string[] = [];
  if (trades.length === 0) findings.push('No trades yet.');
  else {
    const needWin = total.avgWin + total.avgLoss > 0 ? (total.avgLoss / (total.avgWin + total.avgLoss)) * 100 : 50;
    findings.push(
      `${trades.length} trades, ${total.winRate}% won, net ₹${total.net}. Average win ₹${total.avgWin}, average loss ₹${total.avgLoss}: you need about ${Math.round(needWin)}% winners to break even${total.winRate >= needWin ? ' (you are above that)' : ' (you are below that)'}.`,
    );
    const real = (b: Bucket[]) => b.filter((x) => x.trades >= 3);
    for (const b of real(byPattern).filter((x) => x.net < 0).sort((a, b2) => a.net - b2.net).slice(0, 2)) findings.push(`Pattern "${b.key}" lost ₹${-b.net} over ${b.trades} trades (${b.winRate}% won): consider switching it off.`);
    for (const b of real(byPattern).filter((x) => x.net > 0).slice(0, 2)) findings.push(`Pattern "${b.key}" made ₹${b.net} over ${b.trades} trades (${b.winRate}% won): keep it.`);
    const [buy, short] = [bySide.find((b) => b.key === 'Buy'), bySide.find((b) => b.key === 'Short')];
    if (buy && short && buy.trades >= 3 && short.trades >= 3) findings.push(buy.net >= short.net ? `Buys did better than shorts (₹${buy.net} against ₹${short.net}).` : `Shorts did better than buys (₹${short.net} against ₹${buy.net}).`);
    const bad = real(byHour).filter((x) => x.net < 0).sort((a, b2) => a.net - b2.net)[0];
    if (bad) findings.push(`Entries around ${bad.key} lost the most (₹${-bad.net} over ${bad.trades} trades).`);
    const stops = byExit.find((b) => b.key === 'Stop hit');
    if (stops && trades.length >= 5 && stops.trades / trades.length > 0.6) findings.push(`${Math.round((stops.trades / trades.length) * 100)}% of trades ended at the stop: entries are too early or stops too tight for the noise.`);
    const charges = total.charges;
    if (charges > 0 && Math.abs(total.net) > 0 && charges > Math.abs(total.net + charges) * 0.3) findings.push(`Charges took ₹${charges}: that is a big part of the result. Fewer, better trades help.`);
  }
  return { total, byPattern, bySide, byHour, byExit, bySymbol: bySymbol.length > 12 ? [...bySymbol.slice(0, 6), ...bySymbol.slice(-6)] : bySymbol, byDay, findings };
}

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface TradeRow {
  id?: number;
  day: string;
  mode: string;
  symbol: string;
  qty: number;
  entry_price: number;
  exit_price: number;
  entry_ts: number;
  exit_ts: number;
  pattern: string;
  entry_reason: string;
  exit_reason: string;
  charges: number;
  net_pnl: number;
}

export interface ScannerPickRow {
  day: string;
  ts: number;
  symbol: string;
  setup: string;
  score: number;
  entry: number;
  stop: number;
  target1: number;
  target2: number;
  qty: number;
  /** The whole plan as JSON */
  plan: string;
}

export interface EventRow {
  id?: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Small SQLite store using Node's built-in sqlite (no native build, works on Termux). */
export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL, mode TEXT NOT NULL, symbol TEXT NOT NULL, qty INTEGER NOT NULL,
        entry_price REAL NOT NULL, exit_price REAL NOT NULL, entry_ts INTEGER NOT NULL, exit_ts INTEGER NOT NULL,
        pattern TEXT NOT NULL, entry_reason TEXT NOT NULL, exit_reason TEXT NOT NULL,
        charges REAL NOT NULL, net_pnl REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trades_day ON trades(day);
      CREATE TABLE IF NOT EXISTS open_positions (symbol TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scanner_picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL, ts INTEGER NOT NULL, symbol TEXT NOT NULL, setup TEXT NOT NULL, score REAL NOT NULL,
        entry REAL NOT NULL, stop REAL NOT NULL, target1 REAL NOT NULL, target2 REAL NOT NULL, qty INTEGER NOT NULL, plan TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scanner_picks_day ON scanner_picks(day);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL
      );
    `);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  addTrade(t: TradeRow): void {
    this.db
      .prepare(
        `INSERT INTO trades (day, mode, symbol, qty, entry_price, exit_price, entry_ts, exit_ts, pattern, entry_reason, exit_reason, charges, net_pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.day, t.mode, t.symbol, t.qty, t.entry_price, t.exit_price, t.entry_ts, t.exit_ts, t.pattern, t.entry_reason, t.exit_reason, t.charges, t.net_pnl);
  }

  tradesForDay(day: string): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades WHERE day = ? ORDER BY exit_ts DESC').all(day) as unknown as TradeRow[];
  }

  recentTrades(limit = 100): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY exit_ts DESC LIMIT ?').all(limit) as unknown as TradeRow[];
  }

  log(level: EventRow['level'], message: string): void {
    this.db.prepare('INSERT INTO events (ts, level, message) VALUES (?, ?, ?)').run(Date.now(), level, message);
  }

  /** Open paper positions are kept here so a restart does not lose them. */
  saveOpenPosition(symbol: string, json: string): void {
    this.db.prepare('INSERT INTO open_positions (symbol, data) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET data = excluded.data').run(symbol, json);
  }

  deleteOpenPosition(symbol: string): void {
    this.db.prepare('DELETE FROM open_positions WHERE symbol = ?').run(symbol);
  }

  openPositions(): string[] {
    return (this.db.prepare('SELECT data FROM open_positions').all() as unknown as Array<{ data: string }>).map((r) => r.data);
  }

  /** Save a scanner pick the first time it is shown for a share and setup on a day. Returns false if already saved. */
  addScannerPick(p: ScannerPickRow): boolean {
    const have = this.db.prepare('SELECT 1 FROM scanner_picks WHERE day = ? AND symbol = ? AND setup = ?').get(p.day, p.symbol, p.setup);
    if (have) return false;
    this.db
      .prepare('INSERT INTO scanner_picks (day, ts, symbol, setup, score, entry, stop, target1, target2, qty, plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.day, p.ts, p.symbol, p.setup, p.score, p.entry, p.stop, p.target1, p.target2, p.qty, p.plan);
    return true;
  }

  scannerPicks(limit = 2000): Array<ScannerPickRow & { id: number }> {
    return this.db.prepare('SELECT * FROM scanner_picks ORDER BY id DESC LIMIT ?').all(limit) as unknown as Array<ScannerPickRow & { id: number }>;
  }

  allTrades(limit = 5000): TradeRow[] {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit) as unknown as TradeRow[];
  }

  recentEvents(limit = 100): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as unknown as EventRow[];
  }

  close(): void {
    this.db.close();
  }
}

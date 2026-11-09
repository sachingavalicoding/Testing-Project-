import type { Candle, Quote } from '../types.ts';
import type { UpstoxClient } from '../broker/upstoxClient.ts';
import type { PriceFeed } from './feed.ts';

interface FullQuote {
  last_price: number;
  net_change: number;
  volume: number;
  ohlc: { open: number; high: number; low: number; close: number };
  timestamp?: string;
}

/**
 * Live prices from Upstox by asking for all 100 shares in ONE quote call every second.
 * One call per second is far under Upstox limits and needs no WebSocket/protobuf code.
 */
export class UpstoxFeed implements PriceFeed {
  readonly name = 'upstox';
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  lastError: string | undefined;
  private keys: string[] = [];
  private keyToSymbol = new Map<string, string>();

  constructor(private readonly client: UpstoxClient, private readonly intervalMs = 1000) {}

  async start(symbols: readonly string[], onQuotes: (q: Quote[]) => void): Promise<void> {
    await this.client.loadInstruments();
    const known = symbols.filter((s) => this.client.hasKey(s));
    const missing = symbols.filter((s) => !this.client.hasKey(s));
    if (missing.length) this.lastError = `Not found on Upstox: ${missing.join(', ')}`;
    this.keys = known.map((s) => this.client.keyFor(s));
    this.keyToSymbol = new Map(known.map((s) => [this.client.keyFor(s), s]));

    const poll = async () => {
      if (this.busy || !this.client.hasToken) return;
      this.busy = true;
      try {
        const url = this.client.api(`/v2/market-quote/quotes?instrument_key=${encodeURIComponent(this.keys.join(','))}`);
        const data = await this.client.request<Record<string, FullQuote & { instrument_token: string }>>('GET', url);
        const now = Date.now();
        const quotes: Quote[] = [];
        for (const q of Object.values(data ?? {})) {
          const symbol = this.keyToSymbol.get(q.instrument_token);
          if (!symbol) continue;
          quotes.push({
            symbol,
            ltp: q.last_price,
            prevClose: q.last_price - q.net_change,
            open: q.ohlc.open,
            high: q.ohlc.high,
            low: q.ohlc.low,
            volume: q.volume,
            ts: q.timestamp ? Date.parse(q.timestamp) || now : now,
          });
        }
        onQuotes(quotes);
        this.lastError = undefined;
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.busy = false;
      }
    };
    await poll();
    this.timer = setInterval(poll, this.intervalMs);
  }

  search(query: string, limit = 15): string[] {
    return this.client.searchSymbols(query, limit);
  }

  async watch(symbol: string): Promise<boolean> {
    if (!this.client.hasKey(symbol)) return false;
    const key = this.client.keyFor(symbol);
    if (!this.keyToSymbol.has(key)) {
      this.keys.push(key);
      this.keyToSymbol.set(key, symbol);
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getCandles(symbol: string, interval: '1minute' | 'day', days: number): Promise<Candle[]> {
    const key = encodeURIComponent(this.client.keyFor(symbol));
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const d = (x: Date) => x.toISOString().slice(0, 10);
    const path =
      interval === 'day'
        ? `/v3/historical-candle/${key}/days/1/${d(to)}/${d(from)}`
        : `/v3/historical-candle/intraday/${key}/minutes/1`;
    const data = await this.client.request<{ candles: Array<[string, number, number, number, number, number]> }>(
      'GET',
      this.client.api(path),
    );
    return (data?.candles ?? [])
      .map(([t, o, h, l, c, v]) => ({ t: Date.parse(t), o, h, l, c, v }))
      .sort((a, b) => a.t - b.t);
  }
}

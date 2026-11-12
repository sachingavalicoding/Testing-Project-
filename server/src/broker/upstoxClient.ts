import { gunzipSync } from 'node:zlib';

const API = 'https://api.upstox.com';
const HFT = 'https://api-hft.upstox.com';
const INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

/** logged_out: no token yet. ok: token in use. expired: Upstox rejected our token (401), log in again. */
export type AuthState = 'logged_out' | 'ok' | 'expired';

export class UpstoxError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/**
 * Thin Upstox REST client.
 * - Paces every call (Upstox blocked us with 429 before when history calls were too fast).
 * - Backs off and retries on 429.
 * - Token is set at runtime (login flow or UPSTOX_ACCESS_TOKEN), never stored in code.
 */
export class UpstoxClient {
  private token: string;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  private symbolToKey = new Map<string, string>();
  authState: AuthState;
  /** Called once when Upstox answers 401 (token expired or wrong). */
  onUnauthorized: (() => void) | undefined;

  constructor(
    private readonly opts: { apiKey: string; apiSecret: string; redirectUri: string; accessToken?: string; minGapMs?: number },
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.token = opts.accessToken ?? '';
    this.authState = this.token ? 'ok' : 'logged_out';
  }

  get hasToken(): boolean {
    return this.token !== '';
  }

  setToken(token: string): void {
    this.token = token;
    this.authState = token ? 'ok' : 'logged_out';
  }

  /** Upstox refused our token: forget it so we stop calling and the app asks for a new login. */
  invalidate(): void {
    this.token = '';
    this.authState = 'expired';
  }

  loginUrl(): string {
    const p = new URLSearchParams({ response_type: 'code', client_id: this.opts.apiKey, redirect_uri: this.opts.redirectUri });
    return `${API}/v2/login/authorization/dialog?${p}`;
  }

  async exchangeCode(code: string): Promise<string> {
    const body = new URLSearchParams({
      code,
      client_id: this.opts.apiKey,
      client_secret: this.opts.apiSecret,
      redirect_uri: this.opts.redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await this.fetchFn(`${API}/v2/login/authorization/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const json = (await res.json()) as { access_token?: string };
    if (!res.ok || !json.access_token) throw new UpstoxError('Upstox login failed', res.status, json);
    this.setToken(json.access_token);
    return json.access_token;
  }

  /** Loads NSE equity instrument keys once (NSE_EQ|ISIN) so we can map symbols. */
  async loadInstruments(): Promise<void> {
    if (this.symbolToKey.size > 0) return;
    const res = await this.fetchFn(INSTRUMENTS_URL);
    if (!res.ok) throw new UpstoxError('Could not download Upstox instrument list', res.status, null);
    const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as Array<{
      segment: string; instrument_type: string; trading_symbol: string; instrument_key: string;
    }>;
    for (const r of rows) {
      if (r.segment === 'NSE_EQ' && r.instrument_type === 'EQ') this.symbolToKey.set(r.trading_symbol, r.instrument_key);
    }
  }

  setInstrumentKeys(map: Record<string, string>): void {
    for (const [s, k] of Object.entries(map)) this.symbolToKey.set(s, k);
  }

  keyFor(symbol: string): string {
    const key = this.symbolToKey.get(symbol);
    if (!key) throw new Error(`No Upstox instrument key for ${symbol}. Is the symbol right?`);
    return key;
  }

  /** Symbols starting with, then containing, the text. */
  searchSymbols(query: string, limit = 15): string[] {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const starts: string[] = [];
    const contains: string[] = [];
    for (const s of this.symbolToKey.keys()) {
      if (s.startsWith(q)) starts.push(s);
      else if (s.includes(q)) contains.push(s);
    }
    return [...starts.sort((a, b) => a.length - b.length), ...contains].slice(0, limit);
  }

  hasKey(symbol: string): boolean {
    return this.symbolToKey.has(symbol);
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const gap = (this.opts.minGapMs ?? 120) - (Date.now() - this.lastCall);
        if (gap > 0) await sleep(gap);
        this.lastCall = Date.now();
        const res = await this.fetchFn(url, {
          method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 429 && attempt < 4) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        const json = (await res.json().catch(() => null)) as { status?: string; data?: T; errors?: unknown } | null;
        if (res.status === 401) {
          this.invalidate();
          this.onUnauthorized?.();
        }
        if (!res.ok || json?.status === 'error') {
          const detail = (json?.errors as Array<{ message?: string }> | undefined)?.[0]?.message;
          throw new UpstoxError(`Upstox ${method} ${new URL(url).pathname} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status, json);
        }
        return json?.data as T;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  api(path: string): string {
    return `${API}${path}`;
  }

  hft(path: string): string {
    return `${HFT}${path}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

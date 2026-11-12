import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PaperBroker } from '../src/broker/paperBroker.ts';
import { clearToken, loadToken, saveToken } from '../src/broker/tokenStore.ts';
import { UpstoxClient } from '../src/broker/upstoxClient.ts';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/db.ts';
import { MockFeed } from '../src/market/mockFeed.ts';
import { MarketStore } from '../src/market/store.ts';
import { nextTokenExpiry } from '../src/market/time.ts';
import { UpstoxFeed } from '../src/market/upstoxFeed.ts';
import { defaultSettings } from '../src/settings.ts';
import { AutoTrader } from '../src/trading/autoTrader.ts';

const unauthorized = (calls: string[]) =>
  (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ status: 'error', errors: [{ errorCode: 'UDAPI100050', message: 'Invalid token used to access API' }] }), { status: 401 });
  }) as unknown as typeof fetch;

const opts = { apiKey: 'k', apiSecret: 's', redirectUri: 'http://localhost:8080/api/auth/upstox/callback', minGapMs: 0 };

describe('Upstox 401 handling', () => {
  it('forgets the token, says why, and tells the app to log in again', async () => {
    const calls: string[] = [];
    const c = new UpstoxClient({ ...opts, accessToken: 'OLD' }, unauthorized(calls));
    let told = 0;
    c.onUnauthorized = () => told++;
    expect(c.authState).toBe('ok');
    await expect(c.request('GET', c.api('/v2/market-quote/quotes'))).rejects.toThrow(/401.*Invalid token/);
    expect(c.hasToken).toBe(false);
    expect(c.authState).toBe('expired');
    expect(told).toBe(1);
    c.setToken('NEW');
    expect(c.authState).toBe('ok');
  });

  it('feed shows a clear message and stops calling Upstox until a new login', async () => {
    const calls: string[] = [];
    const c = new UpstoxClient({ ...opts, accessToken: 'OLD' }, unauthorized(calls));
    c.setInstrumentKeys({ RELIANCE: 'NSE_EQ|INE002A01018' });
    const feed = new UpstoxFeed(c, 20);
    await feed.start(['RELIANCE'], () => undefined);
    await new Promise((r) => setTimeout(r, 150));
    feed.stop();
    expect(feed.lastError).toBe('Upstox login expired. Log in again.');
    expect(calls).toHaveLength(1); // no hammering with a dead token
  });

  it('sends the saved token as a Bearer header on the quotes call', async () => {
    let auth = '';
    const ok = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ status: 'success', data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new UpstoxClient({ ...opts, accessToken: 'TOK123' }, ok);
    await c.request('GET', c.api('/v2/market-quote/quotes?instrument_key=NSE_EQ%7CX'));
    expect(auth).toBe('Bearer TOK123');
  });
});

describe('token store', () => {
  it('keeps a token until 03:30 IST, then ignores it', () => {
    const db = new Db(':memory:');
    const at = Date.parse('2026-11-12T10:00:00+05:30');
    saveToken(db, 'abc', at);
    expect(loadToken(db, at + 3600_000)).toBe('abc');
    expect(loadToken(db, Date.parse('2026-11-13T03:29:00+05:30'))).toBe('abc');
    expect(loadToken(db, Date.parse('2026-11-13T03:31:00+05:30'))).toBeUndefined();
  });

  it('a token made after midnight but before 03:30 expires the same morning', () => {
    expect(nextTokenExpiry(Date.parse('2026-11-12T02:00:00+05:30'))).toBe(Date.parse('2026-11-12T03:30:00+05:30'));
    expect(nextTokenExpiry(Date.parse('2026-11-12T10:00:00+05:30'))).toBe(Date.parse('2026-11-13T03:30:00+05:30'));
  });

  it('clear and broken data give no token', () => {
    const db = new Db(':memory:');
    saveToken(db, 'abc');
    clearToken(db);
    expect(loadToken(db)).toBeUndefined();
    db.setSetting('upstox_token', '{bad');
    expect(loadToken(db)).toBeUndefined();
    db.setSetting('upstox_token', JSON.stringify({ token: 'old-format', day: '2026-11-12' }));
    expect(loadToken(db)).toBeUndefined();
  });
});

describe('login API', () => {
  const rules = { capital: 30000, dailyLossCap: 500, maxOpenPositions: 3, riskPerTrade: 200, maxDayMovePct: 3, squareOffTime: '15:15' };
  const make = async (upstox?: UpstoxClient) => {
    const db = new Db(':memory:');
    const store = new MarketStore();
    const trader = new AutoTrader({ rules, db, store, paperBroker: new PaperBroker(() => 1), realAllowed: false, patterns: [] });
    const settings = defaultSettings(loadConfig());
    const app = await buildApp({
      db, store, trader, feed: new MockFeed(), upstox, feedWanted: 'upstox', patterns: [],
      universe: { current: 'large', select: async () => undefined },
      settings: { get: () => settings, update: () => settings },
    });
    return { app, db };
  };

  it('status says keys are missing when there is no Upstox client', async () => {
    const { app } = await make();
    const s = (await app.inject({ url: '/api/status' })).json();
    expect(s.upstoxState).toBe('not_configured');
    expect(s.feedWanted).toBe('upstox');
    expect((await app.inject({ url: '/api/auth/upstox/login' })).statusCode).toBe(400);
  });

  it('status goes from logged_out to expired after a 401, and login redirects to Upstox', async () => {
    const c = new UpstoxClient({ ...opts, accessToken: 'OLD' }, unauthorized([]));
    const { app } = await make(c);
    expect((await app.inject({ url: '/api/status' })).json().upstoxState).toBe('ok');
    await c.request('GET', c.api('/v2/x')).catch(() => undefined);
    expect((await app.inject({ url: '/api/status' })).json().upstoxState).toBe('expired');
    const login = await app.inject({ url: '/api/auth/upstox/login' });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain('https://api.upstox.com/v2/login/authorization/dialog');
    expect(login.headers.location).toContain('client_id=k');
  });

  it('callback stores the new token on the server and the app is logged in again', async () => {
    const fake = (async (url: string) =>
      String(url).includes('/login/authorization/token')
        ? new Response(JSON.stringify({ access_token: 'FRESH' }), { status: 200 })
        : new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const c = new UpstoxClient({ ...opts, accessToken: 'OLD' }, fake);
    c.invalidate();
    const { app, db } = await make(c);
    const r = await app.inject({ url: '/api/auth/upstox/callback?code=abc' });
    expect(r.statusCode).toBe(302);
    expect(loadToken(db)).toBe('FRESH');
    expect((await app.inject({ url: '/api/status' })).json().upstoxState).toBe('ok');
  });

  it('also accepts the shorter /upstox/callback address', async () => {
    const fake = (async (url: string) =>
      String(url).includes('/login/authorization/token')
        ? new Response(JSON.stringify({ access_token: 'FRESH2' }), { status: 200 })
        : new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const c = new UpstoxClient({ ...opts, redirectUri: 'http://localhost:5000/upstox/callback' }, fake);
    const { app, db } = await make(c);
    const r = await app.inject({ url: '/upstox/callback?code=abc' });
    expect(r.statusCode).toBe(302);
    expect(loadToken(db)).toBe('FRESH2');
    const login = await app.inject({ url: '/api/auth/upstox/login' });
    expect(login.headers.location).toContain(encodeURIComponent('http://localhost:5000/upstox/callback'));
  });

  it('callback explains a failed login in plain words', async () => {
    const fake = (async () => new Response('{"errors":[]}', { status: 400 })) as unknown as typeof fetch;
    const { app } = await make(new UpstoxClient(opts, fake));
    const r = await app.inject({ url: '/api/auth/upstox/callback?code=bad' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('redirect URL');
    const none = await app.inject({ url: '/api/auth/upstox/callback?error=access_denied' });
    expect(none.body).toContain('access_denied');
  });
});

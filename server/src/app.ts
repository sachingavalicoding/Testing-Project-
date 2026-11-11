import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Db } from './db/db.ts';
import type { MarketStore } from './market/store.ts';
import type { PriceFeed } from './market/feed.ts';
import { istDate } from './market/time.ts';
import type { AutoTrader } from './trading/autoTrader.ts';
import { REAL_CONFIRM_TEXT, type ManualBuyRequest } from './trading/autoTrader.ts';
import { PATTERNS } from './trading/patterns.ts';
import type { UpstoxClient } from './broker/upstoxClient.ts';
import type { Candle, Mode } from './types.ts';
import type { AppSettings } from './settings.ts';
import type { NewsService } from './news/news.ts';
import { buildPicks } from './picks.ts';
import { defaultQuality } from './trading/quality.ts';
import type { ScannerService } from './scanner/service.ts';
import type { Pattern } from './trading/patterns.ts';
import { isUniverseId, UNIVERSES, type UniverseId } from './universe/index.ts';

export interface AppDeps {
  db: Db;
  store: MarketStore;
  trader: AutoTrader;
  feed: PriceFeed;
  upstox?: UpstoxClient;
  universe: { readonly current: UniverseId; select(id: UniverseId): Promise<void> };
  settings: { get(): AppSettings; update(input: unknown): AppSettings };
  news?: NewsService;
  patterns: Pattern[];
  scanner?: ScannerService;
  clientDist?: string;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db, store, trader, feed, upstox } = deps;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const fail = (msg: string) => ({ ok: false, error: msg });

  app.get('/api/status', async () => ({
    ...trader.status(),
    feed: feed.name,
    feedError: (feed as { lastError?: string }).lastError,
    upstoxLoggedIn: upstox?.hasToken ?? false,
    realConfirmText: REAL_CONFIRM_TEXT,
  }));

  app.post<{ Body: { mode: Mode; confirm?: string } }>('/api/mode', async (req, reply) => {
    try {
      trader.setMode(req.body.mode, req.body.confirm);
      return { ok: true, mode: trader.mode };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.post('/api/auto/start', async (_req, reply) => {
    try {
      trader.start();
      return { ok: true };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.post('/api/auto/stop', async () => {
    trader.stop();
    return { ok: true };
  });

  app.post('/api/kill-all', async () => {
    await trader.killAll('Kill-all pressed');
    return { ok: true };
  });

  app.get('/api/universe', async () => ({
    current: deps.universe.current,
    options: Object.values(UNIVERSES).map((u) => ({ id: u.id, name: u.name, count: u.symbols.length, warning: u.warning })),
  }));

  app.post<{ Body: { id: string } }>('/api/universe', async (req, reply) => {
    if (!isUniverseId(req.body?.id)) return reply.code(400).send(fail('id must be large, mid or small'));
    try {
      await deps.universe.select(req.body.id);
      return { ok: true, current: deps.universe.current };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  const SYMBOL = /^[A-Z0-9&-]{1,20}$/;

  /** Search any share by name. */
  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const symbols = feed.search(req.query.q ?? '', 15);
    return symbols.map((symbol) => ({ symbol, ltp: store.quote(symbol)?.ltp }));
  });

  /** Make sure we have a live price for a share (any share, not only the chosen list). */
  const ensureQuote = async (symbol: string): Promise<string | undefined> => {
    if (store.quote(symbol)) return undefined;
    if (!(await feed.watch(symbol))) return `${symbol} was not found. Check the name in the search box.`;
    for (let i = 0; i < 40 && !store.quote(symbol); i++) await new Promise((r) => setTimeout(r, 100));
    return store.quote(symbol) ? undefined : `No live price for ${symbol} yet. Is Upstox logged in?`;
  };

  app.post<{ Body: { symbol?: string } }>('/api/watch', async (req, reply) => {
    const symbol = String(req.body?.symbol ?? '').toUpperCase();
    if (!SYMBOL.test(symbol)) return reply.code(400).send(fail('Bad share name'));
    const err = await ensureQuote(symbol);
    return err ? reply.code(400).send(fail(err)) : { ok: true };
  });

  /** Manual order. BUY opens a long, SELL opens a short (paper only, needs short selling on). To close a position use its close route. */
  app.post<{ Body: Omit<Partial<ManualBuyRequest>, 'side'> & { side?: string } }>('/api/orders', async (req, reply) => {
    const b = req.body ?? {};
    const symbol = String(b.symbol ?? '').toUpperCase();
    if (!SYMBOL.test(symbol)) return reply.code(400).send(fail('Bad share name'));
    // BUY opens a long. SELL opens a short (sell first, buy back later, paper only). To close a position use its close button.
    if (b.side !== undefined && b.side !== 'BUY' && b.side !== 'SELL') return reply.code(400).send(fail('Side must be BUY or SELL'));
    if (b.type !== 'market' && b.type !== 'limit') return reply.code(400).send(fail('Order type must be market or limit'));
    const nums = { qty: b.qty, limitPrice: b.limitPrice, stopPrice: b.stopPrice, stopPct: b.stopPct, targetPrice: b.targetPrice };
    for (const [k, v] of Object.entries(nums)) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return reply.code(400).send(fail(`${k} must be a number`));
    }
    try {
      const err = await ensureQuote(symbol);
      if (err) return reply.code(400).send(fail(err));
      const r = await trader.manualBuy({
        symbol, qty: b.qty as number, type: b.type, limitPrice: b.limitPrice,
        stopPrice: b.stopPrice, stopPct: b.stopPct, targetPrice: b.targetPrice,
        side: b.side === 'SELL' ? 'short' : 'long',
      });
      return { ok: true, ...r };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.delete<{ Params: { id: string } }>('/api/orders/:id', async (req, reply) => {
    try {
      trader.cancelPending(req.params.id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.post<{ Params: { symbol: string } }>('/api/positions/:symbol/close', async (req, reply) => {
    try {
      await trader.manualSell(req.params.symbol.toUpperCase());
      return { ok: true };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.get('/api/settings', async () => ({ settings: deps.settings.get(), active: deps.universe.current }));

  app.put('/api/settings', async (req, reply) => {
    try {
      return { ok: true, settings: deps.settings.update(req.body) };
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  app.get('/api/picks', async () => {
    const s = deps.settings.get();
    return buildPicks({
      store,
      patterns: deps.patterns,
      news: deps.news,
      maxDayMovePct: s.lists[deps.universe.current].maxDayMovePct,
      quality: { ...defaultQuality, enabled: s.qualityGate, targetPct: s.lists[deps.universe.current].targetPct, stopLossPct: s.lists[deps.universe.current].stopLossPct, minRewardRisk: s.minRewardRisk },
    });
  });

  // "Best trades now": watchlist, scored picks with full plans, exit help and your results by setup.
  app.get('/api/scanner', async () => (deps.scanner ? deps.scanner.state() : { enabled: false }));
  app.get('/api/scanner/stats', async () => deps.scanner?.stats() ?? { bySetup: [], byHour: [], off: [] });
  app.get('/api/scanner/exit-help', async () => deps.scanner?.exitHelp() ?? { enabled: false, items: [] });

  app.get<{ Params: { symbol: string } }>('/api/news/:symbol', async (req) => {
    const n = await deps.news?.get(req.params.symbol.toUpperCase());
    return n ?? { symbol: req.params.symbol, score: 0, items: [], resultsSoon: false, fetchedAt: Date.now() };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/movers', async (req) => store.movers(Number(req.query.limit ?? 10)));

  app.get('/api/quotes', async () => store.allQuotes().sort((a, b) => a.symbol.localeCompare(b.symbol)));

  // History is cached for 20 seconds (brokers block fast repeat history calls); live ticks are merged on top.
  const candleCache = new Map<string, { ts: number; candles: Candle[] }>();

  app.get<{ Params: { symbol: string }; Querystring: { interval?: string; days?: string } }>(
    '/api/candles/:symbol',
    async (req, reply) => {
      const interval = req.query.interval === 'day' ? 'day' : '1minute';
      const symbol = req.params.symbol.toUpperCase();
      if (!SYMBOL.test(symbol)) return reply.code(400).send(fail('Bad share name'));
      const days = Math.min(400, Math.max(1, Number(req.query.days ?? (interval === 'day' ? 180 : 5))));
      const key = `${symbol}|${interval}|${days}`;
      let hist = candleCache.get(key);
      if (!hist || Date.now() - hist.ts > 20_000) {
        try {
          await ensureQuote(symbol);
          hist = { ts: Date.now(), candles: await feed.getCandles(symbol, interval, days) };
          candleCache.set(key, hist);
        } catch (e) {
          if (interval === 'day' || store.candlesFor(symbol).length === 0) return reply.code(502).send(fail((e as Error).message));
          hist = { ts: Date.now(), candles: [] };
        }
      }
      if (interval === 'day') return hist.candles;
      const live = store.candlesFor(symbol);
      let out = hist.candles.filter((c) => c.t < (live[0]?.t ?? Infinity));
      if (feed.name === 'mock' && out.length && live.length) {
        // Fake history is random: join it to the live candles so the demo chart has no jump.
        const k = live[0].o / out[out.length - 1].c;
        out = out.map((c) => ({ ...c, o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k }));
      }
      return [...out, ...live];
    },
  );

  app.get<{ Querystring: { day?: string } }>('/api/trades', async (req) =>
    req.query.day ? db.tradesForDay(req.query.day) : db.recentTrades(),
  );

  /** Daily report: every trade today with why it was entered and exited. */
  app.get('/api/report/today', async () => {
    const trades = db.tradesForDay(istDate());
    const net = trades.reduce((s, t) => s + t.net_pnl, 0);
    const charges = trades.reduce((s, t) => s + t.charges, 0);
    return {
      day: istDate(),
      trades,
      count: trades.length,
      wins: trades.filter((t) => t.net_pnl > 0).length,
      net: Math.round(net * 100) / 100,
      charges: Math.round(charges * 100) / 100,
    };
  });

  app.get('/api/events', async () => db.recentEvents(100));

  app.get('/api/patterns', async () => PATTERNS.map((p) => ({ id: p.id, name: p.name })));

  // Live updates pushed once a second (Server-Sent Events: simple, works through any proxy).
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = () => {
      const payload = { status: trader.status(), movers: store.movers(10), ts: Date.now() };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send();
    const t = setInterval(send, 1000);
    req.raw.on('close', () => clearInterval(t));
  });

  // Upstox login (your brother logs in once a day; the token is kept only for that day).
  app.get('/api/auth/upstox/login', async (_req, reply) => {
    if (!upstox) return reply.code(400).send(fail('Upstox keys are not set in .env'));
    return reply.redirect(upstox.loginUrl());
  });

  app.get<{ Querystring: { code?: string } }>('/api/auth/upstox/callback', async (req, reply) => {
    if (!upstox || !req.query.code) return reply.code(400).send(fail('Missing code'));
    try {
      const token = await upstox.exchangeCode(req.query.code);
      db.setSetting('upstox_token', JSON.stringify({ token, day: istDate() }));
      db.log('info', 'Upstox login OK');
      return reply.redirect('/');
    } catch (e) {
      return reply.code(400).send(fail((e as Error).message));
    }
  });

  if (!(deps.clientDist && existsSync(join(deps.clientDist, 'index.html')))) {
    // Friendly message instead of a raw 404 when the web app has not been built yet.
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send(
        '<h2>Stock IQ server is running</h2><p>The web app is not built yet. Stop the server (Ctrl+C) and run:</p>' +
          '<pre>npm install\nnpm run build\nnpm start</pre><p>Then reload this page.</p>',
      ),
    );
  }

  if (deps.clientDist && existsSync(join(deps.clientDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: deps.clientDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send(fail('Not found')) : reply.sendFile('index.html'),
    );
  }

  return app;
}

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
import { REAL_CONFIRM_TEXT } from './trading/autoTrader.ts';
import { PATTERNS } from './trading/patterns.ts';
import type { UpstoxClient } from './broker/upstoxClient.ts';
import type { Mode } from './types.ts';

export interface AppDeps {
  db: Db;
  store: MarketStore;
  trader: AutoTrader;
  feed: PriceFeed;
  upstox?: UpstoxClient;
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

  app.get<{ Querystring: { limit?: string } }>('/api/movers', async (req) => store.movers(Number(req.query.limit ?? 10)));

  app.get('/api/quotes', async () => store.allQuotes().sort((a, b) => a.symbol.localeCompare(b.symbol)));

  app.get<{ Params: { symbol: string }; Querystring: { interval?: string; days?: string } }>(
    '/api/candles/:symbol',
    async (req, reply) => {
      const interval = req.query.interval === 'day' ? 'day' : '1minute';
      const symbol = req.params.symbol.toUpperCase();
      try {
        if (interval === '1minute') {
          const live = store.candlesFor(symbol);
          if (live.length >= 30) return live;
        }
        return await feed.getCandles(symbol, interval, Number(req.query.days ?? (interval === 'day' ? 180 : 1)));
      } catch (e) {
        return reply.code(502).send(fail((e as Error).message));
      }
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

  if (deps.clientDist && existsSync(join(deps.clientDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: deps.clientDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send(fail('Not found')) : reply.sendFile('index.html'),
    );
  }

  return app;
}

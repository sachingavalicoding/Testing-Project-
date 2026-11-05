import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { PaperBroker } from './broker/paperBroker.ts';
import { UpstoxBroker } from './broker/upstoxBroker.ts';
import { UpstoxClient } from './broker/upstoxClient.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import type { PriceFeed } from './market/feed.ts';
import { MockFeed } from './market/mockFeed.ts';
import { MarketStore } from './market/store.ts';
import { istDate } from './market/time.ts';
import { UpstoxFeed } from './market/upstoxFeed.ts';
import { AutoTrader } from './trading/autoTrader.ts';
import { PATTERNS } from './trading/patterns.ts';
import { NIFTY_100 } from './universe/nifty100.ts';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const db = new Db(resolve(here, '..', config.dbPath));
const store = new MarketStore();

let upstox: UpstoxClient | undefined;
if (config.upstox.apiKey) {
  upstox = new UpstoxClient({ ...config.upstox });
  // Reuse today's token if the login already happened today.
  const saved = db.getSetting('upstox_token');
  if (!upstox.hasToken && saved) {
    const { token, day } = JSON.parse(saved) as { token: string; day: string };
    if (day === istDate()) upstox.setToken(token);
  }
}

const feed: PriceFeed = config.feed === 'upstox' && upstox ? new UpstoxFeed(upstox) : new MockFeed();
const realBroker = upstox ? new UpstoxBroker(upstox) : undefined;
const paperBroker = new PaperBroker(
  (s) => store.quote(s)?.ltp,
  // Use real Upstox MIS margin for paper sizing too, whenever logged in.
  upstox && realBroker ? (s, q, p) => (upstox.hasToken ? realBroker.getMargin(s, q, p) : Promise.reject(new Error('no token'))) : undefined,
);

const trader = new AutoTrader({
  rules: config.money,
  db,
  store,
  paperBroker,
  realBroker,
  realAllowed: config.realTradingEnabled,
  patterns: PATTERNS,
  ignoreMarketHours: feed.name === 'mock',
});

await feed.start(NIFTY_100, (quotes) => {
  store.update(quotes);
  void trader.onQuotes(quotes);
});

const app = await buildApp({ db, store, trader, feed, upstox, clientDist: resolve(here, '../../client/dist') });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Stock IQ server on http://localhost:${config.port}  feed=${feed.name}  mode=${trader.mode}  real-lock=${config.realTradingEnabled ? 'OPEN' : 'LOCKED'}`);

const shutdown = () => {
  feed.stop();
  void app.close().then(() => db.close()).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

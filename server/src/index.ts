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
import { loadSettings, defaultSettings, saveSettings, validateSettings, type AppSettings } from './settings.ts';
import { NewsService, shouldBlock } from './news/news.ts';
import { AutoTrader } from './trading/autoTrader.ts';
import { PATTERNS } from './trading/patterns.ts';
import { isUniverseId, UNIVERSES, type UniverseId } from './universe/index.ts';

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

let settings: AppSettings = loadSettings(db, defaultSettings(config));
const savedUniverse = db.getSetting('universe');
let universe: UniverseId = isUniverseId(savedUniverse) ? savedUniverse : 'large';

const feed: PriceFeed = config.feed === 'upstox' && upstox ? new UpstoxFeed(upstox) : new MockFeed();
const realBroker = upstox ? new UpstoxBroker(upstox) : undefined;
const paperBroker = new PaperBroker(
  (s) => store.quote(s)?.ltp,
  // Use real Upstox MIS margin for paper sizing too, whenever logged in.
  upstox && realBroker ? (s, q, p) => (upstox.hasToken ? realBroker.getMargin(s, q, p) : Promise.reject(new Error('no token'))) : undefined,
  5,
  () => settings.lists[universe].slippagePct,
);

const news = new NewsService();
const { maxDayMovePctByList: _unused, ...moneyRules } = config.money;
const trader = new AutoTrader({
  rules: moneyRules,
  db,
  store,
  paperBroker,
  realBroker,
  realAllowed: config.realTradingEnabled,
  patterns: PATTERNS,
  ignoreMarketHours: feed.name === 'mock',
  newsCheck: async (symbol) => {
    const n = await news.get(symbol);
    return n ? shouldBlock(n) : undefined; // news down: do not stop trading
  },
});

/** Push the saved settings (for the active share list) into the trader. */
const applySettings = () => {
  const l = settings.lists[universe];
  trader.setRules({
    maxDayMovePct: l.maxDayMovePct,
    riskPerTrade: l.riskPerTrade,
    maxOpenPositions: l.maxOpenPositions,
    dailyLossCap: settings.dailyLossCap,
  });
  trader.filters.requireAboveVwap = settings.requireAboveVwap;
  trader.filters.newsFilter = settings.newsFilter;
  Object.assign(trader.quality, { enabled: settings.qualityGate, targetPct: l.targetPct, stopLossPct: l.stopLossPct, minRewardRisk: settings.minRewardRisk });
};
applySettings();

const startFeed = () =>
  feed.start(UNIVERSES[universe].symbols, (quotes) => {
    store.update(quotes);
    void trader.onQuotes(quotes);
  });
await startFeed();

/** Switch which 100 shares are watched and traded. Only one list is active at a time. */
const universeControl = {
  get current(): UniverseId {
    return universe;
  },
  async select(id: UniverseId): Promise<void> {
    if (id === universe) return;
    if (trader.positions.size > 0) throw new Error('Close all open positions before changing the share list');
    trader.stop();
    feed.stop();
    store.clear();
    universe = id;
    applySettings();
    db.setSetting('universe', id);
    db.log('warn', `Share list changed to ${UNIVERSES[id].name}`);
    await startFeed();
  },
};

const app = await buildApp({ db, store, trader, feed, upstox, universe: universeControl,
  settings: {
    get: () => settings,
    update(input: unknown) {
      settings = validateSettings(input);
      saveSettings(db, settings);
      applySettings();
      db.log('info', 'Settings saved');
      return settings;
    },
  },
  news,
  patterns: PATTERNS, clientDist: resolve(here, '../../client/dist') });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Stock IQ server on http://localhost:${config.port}  feed=${feed.name}  mode=${trader.mode}  real-lock=${config.realTradingEnabled ? 'OPEN' : 'LOCKED'}`);

const shutdown = () => {
  feed.stop();
  void app.close().then(() => db.close()).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

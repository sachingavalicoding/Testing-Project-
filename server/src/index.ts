import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { PaperBroker } from './broker/paperBroker.ts';
import { UpstoxBroker } from './broker/upstoxBroker.ts';
import { clearToken, loadToken } from './broker/tokenStore.ts';
import { UpstoxClient } from './broker/upstoxClient.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import type { PriceFeed } from './market/feed.ts';
import { MockFeed } from './market/mockFeed.ts';
import { MarketStore } from './market/store.ts';
import { seedHistory } from './market/seed.ts';
import { loadDaily } from './scanner/daily.ts';
import { ScannerService } from './scanner/service.ts';
import { UpstoxFeed } from './market/upstoxFeed.ts';
import { qualityFor, loadSettings, defaultSettings, saveSettings, validateSettings, type AppSettings } from './settings.ts';
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
  // A token saved by the login button (still before its 03:30 IST expiry) wins over a token pasted in .env, which may be old.
  const saved = loadToken(db);
  if (saved) upstox.setToken(saved);
  upstox.onUnauthorized = () => {
    clearToken(db);
    db.log('warn', 'Upstox rejected the login token (401). Log in again.');
  };
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
  newsCheck: async (symbol, side) => {
    const n = await news.get(symbol);
    if (!n) return undefined; // news down: do not stop trading
    // A short is hurt by good news, a long by bad news. Results / board meetings are a risk both ways.
    if (side === 'short') {
      if (n.resultsSoon) return 'results / board meeting news in the last 2 days';
      if (n.score >= 2) return `good news (score ${n.score}): ${n.items[0]?.title ?? ''}`;
      return undefined;
    }
    return shouldBlock(n);
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
  trader.paperCash = settings.paperCash;
  trader.allowShort = settings.shortSelling;
  trader.capitalPerTrade = settings.capitalPerTrade;
  trader.entriesPerMinute = settings.entriesPerMinute;
  trader.minStopWidthPct = settings.minStopWidthPct;
  trader.targetPlan = settings.exitPlan.enabled ? { t1: settings.exitPlan.t1, t2: settings.exitPlan.t2, t3: settings.exitPlan.t3 } : undefined;
  trader.filters.requireAboveVwap = settings.requireAboveVwap;
  trader.filters.newsFilter = settings.newsFilter;
  Object.assign(trader.quality, qualityFor(settings, universe));
};
applySettings();

const scanner = new ScannerService({
  store,
  db,
  news,
  settings: () => settings,
  trader,
  squareOffTime: () => config.money.squareOffTime,
  listKey: () => universe,
});

let seedRun = 0;

/** Yesterday's high, low and volume for the scanner's pre-market list. Only fetched while the scanner is on. */
const loadScannerDaily = () => {
  const run = seedRun;
  void loadDaily(feed, UNIVERSES[universe].symbols, { stillWanted: () => run === seedRun, log: (m) => db.log('info', m) }).then((m) => {
    if (run === seedRun) scanner.setDaily(m);
  });
};
const startFeed = async () => {
  await feed.start(UNIVERSES[universe].symbols, (quotes) => {
    store.update(quotes);
    void trader.onQuotes(quotes);
  });
  // Fill in the day so far in the background; patterns need it (opening range, EMA, RSI, VWAP).
  const run = ++seedRun;
  void seedHistory(feed, store, UNIVERSES[universe].symbols, { stillWanted: () => run === seedRun, log: (m) => db.log('info', m) });
  if (settings.scanner.enabled) loadScannerDaily();
};
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

const app = await buildApp({ db, store, trader, feed, upstox, feedWanted: config.feed, universe: universeControl,
  settings: {
    get: () => settings,
    update(input: unknown) {
      settings = validateSettings(input);
      if (settings.scanner.enabled && scanner.daily.size === 0) loadScannerDaily();
      saveSettings(db, settings);
      applySettings();
      db.log('info', 'Settings saved');
      return settings;
    },
  },
  news,
  scanner,
  patterns: PATTERNS, clientDist: resolve(here, '../../client/dist') });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Stock IQ server on http://localhost:${config.port}  feed=${feed.name}  mode=${trader.mode}  real-lock=${config.realTradingEnabled ? 'OPEN' : 'LOCKED'}`);

const shutdown = () => {
  feed.stop();
  void app.close().then(() => db.close()).finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

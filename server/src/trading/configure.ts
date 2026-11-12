import { qualityFor, type AppSettings } from '../settings.ts';
import type { UniverseId } from '../universe/index.ts';
import type { AutoTrader } from './autoTrader.ts';

/** Push the saved settings (for one share list) into a trader. The live app and the Lab replay use this same function. */
export function applySettingsToTrader(trader: AutoTrader, settings: AppSettings, universe: UniverseId): void {
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
  trader.disabledPatterns = new Set(settings.disabledPatterns);
  Object.assign(trader.quality, qualityFor(settings, universe));
}

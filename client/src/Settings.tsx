import { useEffect, useState } from 'react';
import { get, rupee, type AppSettings, type ListRules, type ScannerSettings } from './api.ts';

type Cap = 'large' | 'mid' | 'small';
const names: Record<Cap, string> = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap' };

function Field({ label, hint, value, onChange, step = 1 }: { label: string; hint: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <label className="block py-1.5">
      <span className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <input type="number" inputMode="decimal" step={step} value={Number.isFinite(value) ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
          className="num w-28 rounded bg-slate-800 px-2 py-1 text-right" />
      </span>
      <span className="text-xs text-slate-500">{hint}</span>
    </label>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="flex items-center justify-between py-1.5 text-sm">
      <span>{label}<br /><span className="text-xs text-slate-500">{hint}</span></span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5" />
    </label>
  );
}

function TimeField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block py-1.5">
      <span className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <input type="time" value={value} onChange={(e) => onChange(e.target.value)} className="num w-28 rounded bg-slate-800 px-2 py-1 text-right" />
      </span>
      <span className="text-xs text-slate-500">{hint}</span>
    </label>
  );
}

const PATTERN_NAMES: Array<[string, string]> = [
  ['orb15', 'Opening range breakout (buy)'], ['vwappb', 'VWAP / EMA pullback bounce (buy)'], ['squeeze', 'Tight range breakout (buy)'], ['ema9x21', 'EMA 9/21 cross up (buy)'], ['mom', 'Momentum breakout (buy)'],
  ['orb15s', 'Opening range breakdown (short)'], ['vwaprj', 'VWAP / EMA rejection (short)'], ['squeezes', 'Tight range breakdown (short)'], ['ema9x21s', 'EMA 9/21 cross down (short)'], ['moms', 'Momentum breakdown (short)'],
];

export default function Settings() {
  const [s, setS] = useState<AppSettings>();
  const [active, setActive] = useState<Cap>('large');
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    get<{ settings: AppSettings; active: Cap }>('/api/settings').then((r) => { setS(r.settings); setActive(r.active); }).catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);
  if (!s) return <p className="text-slate-400">{msg?.text ?? 'Loading…'}</p>;

  const sc = s.scanner;
  const setSc = (patch: Partial<ScannerSettings>) => setS({ ...s, scanner: { ...sc, ...patch } });
  const setList = (cap: Cap, patch: Partial<ListRules>) => setS({ ...s, lists: { ...s.lists, [cap]: { ...s.lists[cap], ...patch } } });
  const setEc = (patch: Partial<AppSettings["entryChecks"]>) => setS({ ...s, entryChecks: { ...s.entryChecks, ...patch } });
  const setCheck = (cap: Cap, patch: Partial<ListRules['checks']>) => setList(cap, { checks: { ...s.lists[cap].checks, ...patch } });

  const save = async () => {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setS(j.settings); setMsg({ ok: true, text: 'Saved. New limits apply to the next entries.' }); }
    else setMsg({ ok: false, text: j.error ?? 'Could not save' });
  };

  return (
    <div className="space-y-3">
      {msg && <div className={`rounded p-2 text-sm ${msg.ok ? 'bg-green-900/50' : 'bg-red-900/60'}`}>{msg.text}</div>}

      {(['large'] as Cap[]).map((cap) => (
        <section key={cap} className={`rounded-lg bg-slate-900 p-3 ${active === cap ? 'ring-1 ring-sky-600' : ''}`}>
          <h2 className="mb-1 font-semibold">{names[cap]} {active === cap && <span className="text-xs font-normal text-sky-400">(in use now)</span>}</h2>
          <Field label="Skip if already moved (%)" hint="Do not buy shares that already moved more than this today" step={0.5}
            value={s.lists[cap].maxDayMovePct} onChange={(n) => setList(cap, { maxDayMovePct: n })} />
          <Field label="Risk per trade (₹)" hint="Most you accept to lose on one trade, charges included. Not used while Capital per trade is set"
            value={s.lists[cap].riskPerTrade} onChange={(n) => setList(cap, { riskPerTrade: n })} />
          <Field label="Max open positions" hint="How many shares can be held at the same time"
            value={s.lists[cap].maxOpenPositions} onChange={(n) => setList(cap, { maxOpenPositions: n })} />
          <Field label="Profit target (%)" hint="Sell when the share gains this much (minimum 0.75)" step={0.25}
            value={s.lists[cap].targetPct} onChange={(n) => setList(cap, { targetPct: n })} />
          <Field label="Widest stop loss (%)" hint="Entries whose natural stop is wider than this are skipped" step={0.1}
            value={s.lists[cap].stopLossPct} onChange={(n) => setList(cap, { stopLossPct: n })} />
          <p className="mt-2 text-xs font-semibold text-slate-400">Entry checks for this list (buy and short)</p>
          <Field label="Minimum pattern score" hint="Out of 100. Noisier lists need a higher score" value={s.lists[cap].checks.minScore ?? s.entryChecks.minScore} onChange={(n) => setCheck(cap, { minScore: n })} />
          <Field label="Volume vs recent average (times)" hint="Mid and small caps fake breakouts on thin volume: ask for more" step={0.1} value={s.lists[cap].checks.minVolumeRatio ?? s.entryChecks.minVolumeRatio} onChange={(n) => setCheck(cap, { minVolumeRatio: n })} />
          <Field label="Most stretched from EMA9 (%)" hint="Do not chase. Volatile shares get more room" step={0.1} value={s.lists[cap].checks.maxStretchPct ?? s.entryChecks.maxStretchPct} onChange={(n) => setCheck(cap, { maxStretchPct: n })} />
          <Field label="Trend strength, ADX (0 = off)" hint="Under about 18 the share is just chopping sideways. 20+ is a real trend" value={s.lists[cap].checks.minAdx ?? s.entryChecks.minAdx} onChange={(n) => setCheck(cap, { minAdx: n })} />
          <Field label="Stop at least this many ATRs (0 = off)" hint="ATR is the normal one-minute move. A stop tighter than this is knocked out by ordinary noise. Capped by Widest stop loss" step={0.1} value={s.lists[cap].checks.atrStopMult ?? s.entryChecks.atrStopMult} onChange={(n) => setCheck(cap, { atrStopMult: n })} />
        </section>
      ))}

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">For all lists</h2>
        <Field label="Capital per trade (₹)" hint={`Your own money put into each trade. Upstox leverage (about 5x) multiplies it: ${rupee(s.capitalPerTrade)} buys about ${rupee(s.capitalPerTrade * 5)} of shares. 0 = size by risk per trade instead`} step={1000}
          value={s.capitalPerTrade} onChange={(n) => setS({ ...s, capitalPerTrade: n })} />
        <Field label="Most new trades per minute" hint="Stops a burst of entries on the same market move. The best scores go first, the rest wait for the next minute"
          value={s.entriesPerMinute} onChange={(n) => setS({ ...s, entriesPerMinute: n })} />
        <Toggle label="Allow short selling (intraday)" hint="Sell first, buy back later, to make money when a share falls. Paper mode only: it is not tried with real Upstox orders yet. The auto trader then also takes bearish entries, and the order ticket gets a Short button" value={s.shortSelling} onChange={(b) => setS({ ...s, shortSelling: b })} />
        <Field label="Paper cash (₹)" hint={`Pretend money for paper trading (now ${rupee(s.paperCash)}). Real mode uses CAPITAL from the server .env`} step={1000}
          value={s.paperCash} onChange={(n) => setS({ ...s, paperCash: n })} />
        <Field label="Daily loss cap (₹)" hint={`Sell everything and stop for the day at this loss (now ${rupee(s.dailyLossCap)})`}
          value={s.dailyLossCap} onChange={(n) => setS({ ...s, dailyLossCap: n })} />
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Buy only above today's average price (VWAP)<br /><span className="text-xs text-slate-500">Avoids buying while sellers are in control</span></span>
          <input type="checkbox" checked={s.requireAboveVwap} onChange={(e) => setS({ ...s, requireAboveVwap: e.target.checked })} className="h-5 w-5" />
        </label>
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Skip shares with bad news or results due<br /><span className="text-xs text-slate-500">Uses news headlines. If news is down, trading goes on</span></span>
          <input type="checkbox" checked={s.newsFilter} onChange={(e) => setS({ ...s, newsFilter: e.target.checked })} className="h-5 w-5" />
        </label>
      </section>

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Better entries and profit target</h2>
        <label className="flex items-center justify-between py-1.5 text-sm">
          <span>Only take high quality entries<br /><span className="text-xs text-slate-500">Needs short-term uptrend (EMA9 above EMA21), healthy RSI, price not stretched above VWAP, no entries in the first 10 minutes or after 2:30 PM, and skips the day when most shares are falling</span></span>
          <input type="checkbox" checked={s.qualityGate} onChange={(e) => setS({ ...s, qualityGate: e.target.checked })} className="h-5 w-5" />
        </label>
        <Field label="Reward to risk (times)" hint="The target must be at least this many times the stop distance, otherwise the trade is skipped" step={0.25}
          value={s.minRewardRisk} onChange={(n) => setS({ ...s, minRewardRisk: n })} />
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Stop loss and 3 close targets</h2>
        <Toggle label="Use calculated stop + targets 1, 2, 3" hint="Every auto trade gets its stop from the chart and three targets close to the entry, measured in times the risk (entry to stop). Target 1: stop moves to break-even, so the trade can no longer lose. Target 2: stop moves to target 1. Target 3: sell everything" value={s.exitPlan.enabled} onChange={(b) => setS({ ...s, exitPlan: { ...s.exitPlan, enabled: b } })} />
        <Field label="Minimum stop width (%)" hint="Every new trade gets at least this wide a stop below the entry, so normal price noise does not knock it out. The targets are measured from this stop, so a wider stop means bigger targets too. Keep it at or below Widest stop loss" step={0.1}
          value={s.minStopWidthPct} onChange={(n) => setS({ ...s, minStopWidthPct: n })} />
        <Field label="Target 1 (times the risk)" hint="1 = as far above the entry as the stop is below it" step={0.25}
          value={s.exitPlan.t1} onChange={(n) => setS({ ...s, exitPlan: { ...s.exitPlan, t1: n } })} />
        <Field label="Target 2 (times the risk)" hint="Must be bigger than target 1" step={0.25}
          value={s.exitPlan.t2} onChange={(n) => setS({ ...s, exitPlan: { ...s.exitPlan, t2: n } })} />
        <Field label="Target 3 (times the risk)" hint="Last target: the trade is sold here. Keep it close so it can really be hit" step={0.25}
          value={s.exitPlan.t3} onChange={(n) => setS({ ...s, exitPlan: { ...s.exitPlan, t3: n } })} />
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Entry patterns <span className="text-xs font-normal text-slate-500">(the Lab tab shows which ones earn money)</span></h2>
        {PATTERN_NAMES.map(([id, name]) => (
          <Toggle key={id} label={name} hint={id} value={!(s.disabledPatterns ?? []).includes(id)}
            onChange={(on) => setS({ ...s, disabledPatterns: on ? (s.disabledPatterns ?? []).filter((x) => x !== id) : [...(s.disabledPatterns ?? []), id] })} />
        ))}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Entry checks <span className="text-xs font-normal text-slate-500">(only the best setups pass; 0 turns a check off)</span></h2>
        <Field label="Minimum pattern score" hint="Out of 100. Most good entries score 80 or more" value={s.entryChecks.minScore} onChange={(n) => setEc({ minScore: n })} />
        <Field label="Volume vs recent average (times)" hint="The signal candle must trade at least this many times the average of the 20 candles before it" step={0.1} value={s.entryChecks.minVolumeRatio} onChange={(n) => setEc({ minVolumeRatio: n })} />
        <Field label="Smallest stop (%)" hint="A stop tighter than this gets hit by normal noise" step={0.05} value={s.entryChecks.minStopPct} onChange={(n) => setEc({ minStopPct: n })} />
        <Field label="Most above EMA9 (%)" hint="Do not chase: skip when price is already this far above the 9-candle average (below it for a short)" step={0.1} value={s.entryChecks.maxStretchPct} onChange={(n) => setEc({ maxStretchPct: n })} />
        <Field label="Signal candle strength (0 to 0.95)" hint="0.6 = the candle must close in the top 40% of its range (bottom 40% for a short)" step={0.05} value={s.entryChecks.candleStrength} onChange={(n) => setEc({ candleStrength: n })} />
        <Field label="Room to target 1 (times)" hint="Skip when today's high is closer than this many times target 1: the price would hit a wall" step={0.1} value={s.entryChecks.roomToTarget} onChange={(n) => setEc({ roomToTarget: n })} />
        <Field label="Trend strength, ADX (0 = off)" hint="Default for all lists (each list above can differ). ADX under about 18 means the share is moving sideways: breakouts fail" value={s.entryChecks.minAdx} onChange={(n) => setEc({ minAdx: n })} />
        <Toggle label="MACD must agree" hint="For a buy the MACD histogram must be above zero and rising, for a short below zero and falling: momentum is really building in your direction" value={s.entryChecks.macdConfirm === 1} onChange={(b) => setEc({ macdConfirm: b ? 1 : 0 })} />
        <Toggle label="Slower trend must agree (EMA50)" hint="Buy only above the 50-candle average, short only below it. Skipped until 55 candles exist" value={s.entryChecks.slowTrend === 1} onChange={(b) => setEc({ slowTrend: b ? 1 : 0 })} />
        <Field label="Stop at least this many ATRs (0 = off)" hint="Default for all lists. Widens a too-tight stop to a few times the normal one-minute move" step={0.1} value={s.entryChecks.atrStopMult} onChange={(n) => setEc({ atrStopMult: n })} />
        <Toggle label="EMA21 must be sloping the right way" hint="Rising for a buy, falling for a short, over the last 5 candles" value={s.entryChecks.trendSlope === 1} onChange={(b) => setEc({ trendSlope: b ? 1 : 0 })} />
      </section>

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">Best trades scanner <span className="text-xs font-normal text-slate-500">(the Best tab)</span></h2>
        <Toggle label="Switch the scanner on" hint="Off by default. Finds the few best intraday trades and plans each one. Nothing is scanned or saved while off" value={sc.enabled} onChange={(b) => setSc({ enabled: b })} />
        <Field label="Watchlist size" hint="Shares kept on the day's list, picked before the open" value={sc.watchlistSize} onChange={(n) => setSc({ watchlistSize: n })} />
        <Field label="Minimum score (out of 100)" hint="Only shares scoring this or more are shown" value={sc.minScore} onChange={(n) => setSc({ minScore: n })} />
        <TimeField label="Scan from" hint="Earliest time for a pick" value={sc.scanFrom} onChange={(v) => setSc({ scanFrom: v })} />
        <TimeField label="Scan until" hint="No new picks after this time" value={sc.scanTo} onChange={(v) => setSc({ scanTo: v })} />
        <Field label="No entries in the first (minutes)" hint="After the 09:15 open, the opening minutes are too jumpy" value={sc.noEntryFirstMinutes} onChange={(n) => setSc({ noEntryFirstMinutes: n })} />
        <Field label="Risk per planned trade (₹)" hint="Most you accept to lose on a pick, charges included. Sets the quantity" value={sc.riskPerTrade} onChange={(n) => setSc({ riskPerTrade: n })} />
        <Field label="Stop distance (times ATR)" hint="Stop is 1 to this many 5-minute ATRs below the entry (or the recent low in that range)" value={sc.atrStopMult} step={0.25} onChange={(n) => setSc({ atrStopMult: n })} />
        <Field label="Closest stop (%)" hint="Stops closer than this get hit by noise and charges" value={sc.minStopPct} step={0.05} onChange={(n) => setSc({ minStopPct: n })} />
        <Field label="Widest stop (%)" hint="No plan if the stop would have to be wider than this" value={sc.maxStopPct} step={0.1} onChange={(n) => setSc({ maxStopPct: n })} />
        <Field label="Market counts as flat inside (%)" hint="Median share inside plus or minus this, with most shares barely moving" value={sc.chopMovePct} step={0.05} onChange={(n) => setSc({ chopMovePct: n })} />
        <Toggle label="Require a volume surge" hint="Skip a pick when the last 5 minutes trade on thin volume. A breakout without volume often fails" value={sc.requireVolume} onChange={(b) => setSc({ requireVolume: b })} />
        <Field label="Volume surge (times the day's average)" hint="Last 5 minutes must be at least this many times the day's earlier average. 1.2 means 20% more" value={sc.minVolumeRatio} step={0.1} onChange={(n) => setSc({ minVolumeRatio: n })} />
        <Toggle label="Block when the market is choppy" hint="Flat market: breakouts tend to fail" value={sc.blockChoppy} onChange={(b) => setSc({ blockChoppy: b })} />
        <Toggle label="Block shares near big news" hint="Bad news or results / board meeting in the last 2 days" value={sc.blockNearNews} onChange={(b) => setSc({ blockNearNews: b })} />
        <Toggle label="Block after the daily loss limit" hint={`Uses your daily loss cap (now ${rupee(s.dailyLossCap)})`} value={sc.blockAfterLossLimit} onChange={(b) => setSc({ blockAfterLossLimit: b })} />
        <Toggle label="No averaging down" hint="Do not show a share you already hold" value={sc.blockAveraging} onChange={(b) => setSc({ blockAveraging: b })} />
        <Toggle label="Exit help for open positions" hint="Move stop to cost at 1R, sell half, trail, and warn on VWAP break, dry volume or reversal. Advice only: it places no orders" value={sc.exitHelp} onChange={(b) => setSc({ exitHelp: b })} />
        <Field label="Square-off warning (minutes before)" hint="Warn this long before your square-off time" value={sc.squareOffWarnMin} onChange={(n) => setSc({ squareOffWarnMin: n })} />
        <Toggle label="Learn from my results" hint="Turn off setups that keep losing, judged on your own paper trades from the plan button" value={sc.learn} onChange={(b) => setSc({ learn: b })} />
        <Field label="Trades before judging a setup" hint="A setup is judged only after this many of your trades" value={sc.learnMinTrades} onChange={(n) => setSc({ learnMinTrades: n })} />
        <Field label="Lowest win rate (%)" hint="A judged setup below this win rate is turned off" value={sc.learnMinWinRate} onChange={(n) => setSc({ learnMinWinRate: n })} />
      </section>

      <button onClick={save} className="w-full rounded bg-sky-700 py-3 font-bold">Save settings</button>
    </div>
  );
}

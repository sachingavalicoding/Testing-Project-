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

  const save = async () => {
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setS(j.settings); setMsg({ ok: true, text: 'Saved. New limits apply to the next entries.' }); }
    else setMsg({ ok: false, text: j.error ?? 'Could not save' });
  };

  return (
    <div className="space-y-3">
      {msg && <div className={`rounded p-2 text-sm ${msg.ok ? 'bg-green-900/50' : 'bg-red-900/60'}`}>{msg.text}</div>}

      {(['large', 'mid', 'small'] as Cap[]).map((cap) => (
        <section key={cap} className={`rounded-lg bg-slate-900 p-3 ${active === cap ? 'ring-1 ring-sky-600' : ''}`}>
          <h2 className="mb-1 font-semibold">{names[cap]} {active === cap && <span className="text-xs font-normal text-sky-400">(in use now)</span>}</h2>
          <Field label="Skip if already moved (%)" hint="Do not buy shares that already moved more than this today" step={0.5}
            value={s.lists[cap].maxDayMovePct} onChange={(n) => setList(cap, { maxDayMovePct: n })} />
          <Field label="Risk per trade (₹)" hint="Most you accept to lose on one trade, charges included. Not used while Capital per trade is set"
            value={s.lists[cap].riskPerTrade} onChange={(n) => setList(cap, { riskPerTrade: n })} />
          <Field label="Max open positions" hint="How many shares can be held at the same time"
            value={s.lists[cap].maxOpenPositions} onChange={(n) => setList(cap, { maxOpenPositions: n })} />
          <Field label="Paper slippage (%)" hint="Makes paper fills a bit worse, like real life. Small caps slip more" step={0.05}
            value={s.lists[cap].slippagePct} onChange={(n) => setList(cap, { slippagePct: n })} />
          <Field label="Profit target (%)" hint="Sell when the share gains this much (minimum 0.75)" step={0.25}
            value={s.lists[cap].targetPct} onChange={(n) => setList(cap, { targetPct: n })} />
          <Field label="Widest stop loss (%)" hint="Entries whose natural stop is wider than this are skipped" step={0.1}
            value={s.lists[cap].stopLossPct} onChange={(n) => setList(cap, { stopLossPct: n })} />
        </section>
      ))}

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-1 font-semibold">For all lists</h2>
        <Field label="Capital per trade (₹)" hint={`Your own money put into each trade. Upstox leverage (about 5x) multiplies it: ${rupee(s.capitalPerTrade)} buys about ${rupee(s.capitalPerTrade * 5)} of shares. 0 = size by risk per trade instead`} step={1000}
          value={s.capitalPerTrade} onChange={(n) => setS({ ...s, capitalPerTrade: n })} />
        <Field label="Most new trades per minute" hint="Stops a burst of entries on the same market move. The best scores go first, the rest wait for the next minute"
          value={s.entriesPerMinute} onChange={(n) => setS({ ...s, entriesPerMinute: n })} />
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

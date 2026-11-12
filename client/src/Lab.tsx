import { useEffect, useState } from 'react';
import { get, post, rupee } from './api.ts';

type Section = 'report' | 'replay' | 'learn' | 'data';

interface Bucket { key: string; trades: number; wins: number; winRate: number; net: number; avgWin: number; avgLoss: number; profitFactor: number; expectancy: number; charges: number }
interface Report { total: Bucket; byPattern: Bucket[]; bySide: Bucket[]; byHour: Bucket[]; byExit: Bucket[]; bySymbol: Bucket[]; byDay: Bucket[]; findings: string[] }
interface Days { days: Array<{ day: string; symbols: number; candles: number }>; learnable: string[] }

const color = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-slate-300');
const card = 'rounded-2xl border border-slate-800 bg-slate-900 p-3';
const btn = 'rounded-lg bg-sky-700 px-3 py-2 text-sm font-semibold disabled:opacity-40';
const btn2 = 'rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold disabled:opacity-40';

async function call<T>(path: string, body?: unknown): Promise<T> { return post<T>(path, body); }

function useLoop<T>(path: string, every: number, on = true) {
  const [v, setV] = useState<T>();
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = () => get<T>(path).then((r) => alive && setV(r)).catch(() => undefined);
    void load();
    const t = setInterval(load, every);
    return () => { alive = false; clearInterval(t); };
  }, [path, every, on]);
  return v;
}

function Table({ title, rows, hint }: { title: string; rows: Bucket[]; hint?: string }) {
  if (rows.length === 0) return null;
  return (
    <section className={card}>
      <h3 className="font-semibold">{title}</h3>
      {hint && <p className="mb-1 text-xs text-slate-500">{hint}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-xs">
          <thead className="text-left text-slate-500"><tr><th className="py-1">&nbsp;</th><th>Trades</th><th>Won</th><th>Avg win</th><th>Avg loss</th><th>Profit factor</th><th className="text-right">Net</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} className="border-t border-slate-800">
                <td className="py-1 font-medium">{b.key}</td>
                <td className="num">{b.trades}</td>
                <td className="num">{b.winRate}%</td>
                <td className="num text-green-400">{b.avgWin}</td>
                <td className="num text-red-400">{b.avgLoss}</td>
                <td className="num">{b.profitFactor >= 99 ? '∞' : b.profitFactor}</td>
                <td className={`num text-right font-semibold ${color(b.net)}`}>{rupee(b.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportView() {
  const [days, setDays] = useState(30);
  const [mode, setMode] = useState('paper');
  const r = useLoop<Report>(`/api/lab/report?days=${days}&mode=${mode}`, 15000);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        {[1, 5, 30, 365].map((d) => <button key={d} onClick={() => setDays(d)} className={days === d ? btn : btn2}>{d === 1 ? 'Today' : d === 365 ? 'All' : `Last ${d} days`}</button>)}
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="rounded-lg bg-slate-800 px-2"><option value="paper">Paper</option><option value="real">Real</option></select>
      </div>
      {!r ? <p className="text-slate-400">Loading…</p> : (
        <>
          <section className={card}>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><div className="text-xs text-slate-500">Trades</div><div className="num font-bold">{r.total.trades}</div></div>
              <div><div className="text-xs text-slate-500">Won</div><div className="num font-bold">{r.total.winRate}%</div></div>
              <div><div className="text-xs text-slate-500">Net (after charges)</div><div className={`num font-bold ${color(r.total.net)}`}>{rupee(r.total.net)}</div></div>
              <div><div className="text-xs text-slate-500">Profit factor</div><div className="num font-bold">{r.total.profitFactor >= 99 ? '∞' : r.total.profitFactor}</div></div>
              <div><div className="text-xs text-slate-500">Per trade</div><div className={`num font-bold ${color(r.total.expectancy)}`}>{rupee(r.total.expectancy)}</div></div>
              <div><div className="text-xs text-slate-500">Charges</div><div className="num font-bold">{rupee(r.total.charges)}</div></div>
            </div>
          </section>
          <section className={card}>
            <h3 className="mb-1 font-semibold">What this says</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">{r.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </section>
          <Table title="By pattern" rows={r.byPattern} hint="Which entry setups make money. Profit factor above 1 = profitable" />
          <Table title="Buy or short" rows={r.bySide} />
          <Table title="How trades ended" rows={r.byExit} />
          <Table title="By entry hour" rows={r.byHour} />
          <Table title="By day" rows={r.byDay} />
          <Table title="Best and worst shares" rows={r.bySymbol} />
        </>
      )}
    </div>
  );
}

const SPEEDS: Array<[number, string]> = [[1, '1x'], [2, '2x'], [5, '5x'], [10, '10x'], [25, '25x'], [50, '50x'], [0, 'Max']];

interface ReplayState {
  active: boolean; speed?: number; paused?: boolean; day?: string; clock?: string; progress?: number; finished?: boolean;
  realized?: number; unrealized?: number;
  positions?: Array<{ symbol: string; side: string; entry: number; ltp: number; stop: number; stage: number; pnl: number; pattern: string }>;
  trades?: Array<{ id?: number; symbol: string; side?: string; pattern: string; net_pnl: number; exit_reason: string; entry_price: number; exit_price: number; qty: number }>;
  events?: Array<{ id?: number; ts: number; message: string }>;
}

function ReplayView({ days }: { days?: Days }) {
  const [day, setDay] = useState('');
  const [speed, setSpeed] = useState(10);
  const [err, setErr] = useState<string>();
  const st = useLoop<ReplayState>('/api/lab/replay', 800);
  useEffect(() => { if (!day && days?.learnable.length) setDay(days.learnable[days.learnable.length - 1]); }, [days, day]);
  const ctl = (action: string, sp?: number) => call('/api/lab/replay/control', { action, speed: sp }).catch((e: Error) => setErr(e.message));
  const start = () => { setErr(undefined); call('/api/lab/replay', { day, speed }).catch((e: Error) => setErr(e.message)); };
  const live = st?.active;
  const cur = live ? st.speed ?? speed : speed;
  return (
    <div className="space-y-3">
      <section className={card}>
        <h3 className="mb-1 font-semibold">Replay a saved day</h3>
        <p className="mb-2 text-xs text-slate-500">Plays the whole day from 09:15 as if it were live, through the same trading rules, in a separate sandbox. Nothing here touches your real or paper account.</p>
        {!days || days.days.length === 0 ? <p className="text-sm text-amber-300">No saved days yet. The app saves each live day automatically (every minute while the market feed is on). Open the Data tab to save now or import earlier days.</p> : (
          <div className="flex flex-wrap items-center gap-2">
            <select value={day} onChange={(e) => setDay(e.target.value)} className="rounded-lg bg-slate-800 px-2 py-2 text-sm">
              {days.days.map((d) => <option key={d.day} value={d.day} disabled={!days.learnable.includes(d.day)}>{d.day} ({d.symbols} shares){days.learnable.includes(d.day) ? '' : ' · too little data'}</option>)}
            </select>
            <button disabled={!day} onClick={start} className={btn}>{live ? 'Restart' : 'Start replay'}</button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SPEEDS.map(([v, label]) => (
            <button key={v} onClick={() => { setSpeed(v); if (live) void ctl('speed', v); }} className={`rounded-lg px-3 py-1.5 text-xs font-bold ${cur === v ? 'bg-sky-600' : 'bg-slate-800'}`}>{label}</button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">At 1x a replayed minute takes a real minute; at 50x about a second. Max runs as fast as the computer can.</p>
        {err && <div className="mt-2 rounded bg-red-900/60 p-2 text-sm">{err}</div>}
      </section>

      {live && (
        <>
          <section className={card}>
            <div className="flex items-center justify-between">
              <div><div className="text-xs text-slate-500">{st.day} · replay clock</div><div className="num text-2xl font-bold">{st.clock}</div></div>
              <div className="text-right"><div className="text-xs text-slate-500">Day result so far</div><div className={`num text-xl font-bold ${color((st.realized ?? 0) + (st.unrealized ?? 0))}`}>{rupee((st.realized ?? 0) + (st.unrealized ?? 0))}</div><div className="text-[11px] text-slate-500">closed {rupee(st.realized ?? 0)} · open {rupee(st.unrealized ?? 0)}</div></div>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded bg-slate-800"><div className="h-full bg-sky-500" style={{ width: `${Math.round((st.progress ?? 0) * 100)}%` }} /></div>
            <div className="mt-2 flex gap-2">
              {!st.finished && <button className={btn2} onClick={() => ctl(st.paused ? 'resume' : 'pause')}>{st.paused ? '▶ Resume' : '⏸ Pause'}</button>}
              <button className={btn2} onClick={() => ctl('stop')}>■ Stop</button>
              {st.finished && <span className="self-center text-sm text-green-400">Day finished</span>}
            </div>
          </section>
          <section className={card}>
            <h3 className="mb-1 font-semibold">Open positions ({st.positions?.length ?? 0})</h3>
            {(st.positions ?? []).map((p) => (
              <div key={p.symbol} className="flex justify-between border-t border-slate-800 py-1 text-sm">
                <span>{p.symbol} <span className={`rounded px-1 text-[10px] font-bold ${p.side === 'short' ? 'bg-red-800' : 'bg-green-800'}`}>{p.side === 'short' ? 'SHORT' : 'BUY'}</span> <span className="text-xs text-slate-500">{p.pattern} · T{p.stage}</span></span>
                <span className="num">{p.entry} → {p.ltp} <span className={color(p.pnl)}>{rupee(p.pnl)}</span></span>
              </div>
            ))}
          </section>
          <section className={card}>
            <h3 className="mb-1 font-semibold">Closed trades ({st.trades?.length ?? 0})</h3>
            {(st.trades ?? []).map((t, i) => (
              <div key={i} className="border-t border-slate-800 py-1 text-xs">
                <div className="flex justify-between text-sm"><span>{t.symbol} {t.side === 'short' ? '· short' : ''} <span className="text-xs text-slate-500">{t.pattern}</span></span><span className={`num ${color(t.net_pnl)}`}>{rupee(t.net_pnl)}</span></div>
                <div className="text-slate-500">{t.exit_reason}</div>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

interface AblationState { status: string; message?: string; done?: number; total?: number; result?: { base: { net: number; trades: number; winRate: number; days: number }; rows: Array<{ name: string; value: string; netWithout: number; tradesWithout: number; adds: number }> } }
interface OptState {
  status: string; message?: string; rounds: Array<{ round: number; best: number; net: number; trades: number; change?: string }>; totalRounds: number; days: number;
  result?: { start: { net: number; trades: number; winRate: number; profitableDays: number; days: number }; best: { net: number; trades: number; winRate: number; profitableDays: number; days: number; byPattern: Record<string, { trades: number; net: number }> }; changes: Array<{ name: string; from: string; to: string }>; stopped: boolean };
}

function LearnView({ days }: { days?: Days }) {
  const [msg, setMsg] = useState<string>();
  const [rounds, setRounds] = useState(12);
  const ab = useLoop<AblationState>('/api/lab/ablation', 2000);
  const op = useLoop<OptState>('/api/lab/optimize', 2000);
  const n = days?.learnable.length ?? 0;
  const busy = ab?.status === 'running' || op?.status === 'running';
  const run = (path: string, body?: unknown) => { setMsg(undefined); call(path, body).catch((e: Error) => setMsg(e.message)); };
  return (
    <div className="space-y-3">
      <section className={card}>
        <h3 className="font-semibold">Learn from saved days</h3>
        <p className="text-xs text-slate-400">{n} saved day{n === 1 ? '' : 's'} to learn from. {n < 5 && <span className="text-amber-300">With fewer than 5 days the result is mostly luck of those days: use it to see how things work, and apply it only once there are more days across up and down markets.</span>}</p>
        <p className="mt-1 text-xs text-slate-500">Large caps only. Every test replays all saved days through the real trading rules in a sandbox, so it can take a few minutes. It is best run when the market is closed.</p>
        {msg && <div className="mt-2 rounded bg-red-900/60 p-2 text-sm">{msg}</div>}
      </section>

      <section className={card}>
        <h3 className="font-semibold">1. Which checks and patterns earn money?</h3>
        <p className="mb-2 text-xs text-slate-500">Plays the days once with each check or pattern switched off. "Adds" is how many rupees that check earns: positive = keep it, negative = it costs you.</p>
        <div className="flex gap-2">
          <button disabled={busy || n === 0} className={btn} onClick={() => run('/api/lab/ablation')}>Run the test</button>
          {busy && <button className={btn2} onClick={() => run('/api/lab/stop')}>Stop</button>}
        </div>
        {ab?.status === 'running' && <p className="mt-2 text-sm text-sky-300">Testing… {ab.done ?? 0} of {ab.total || '…'}</p>}
        {ab?.status === 'error' && <p className="mt-2 text-sm text-red-300">{ab.message}</p>}
        {ab?.result && (
          <div className="mt-2 overflow-x-auto">
            <p className="mb-1 text-xs text-slate-400">With everything as it is now: {ab.result.base.trades} trades, {ab.result.base.winRate}% won, net {rupee(ab.result.base.net)}.</p>
            <table className="w-full min-w-[420px] text-xs">
              <thead className="text-left text-slate-500"><tr><th className="py-1">Check / pattern</th><th>Now</th><th>Net without it</th><th className="text-right">Adds</th></tr></thead>
              <tbody>{ab.result.rows.map((r) => (
                <tr key={r.name} className="border-t border-slate-800"><td className="py-1">{r.name}</td><td>{r.value}</td><td className="num">{rupee(r.netWithout)}</td><td className={`num text-right font-semibold ${color(r.adds)}`}>{rupee(r.adds)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className={card}>
        <h3 className="font-semibold">2. Learn better settings</h3>
        <p className="mb-2 text-xs text-slate-500">Tries combinations of checks, stop width, targets, short selling and patterns. Each round tries a few changes on the best settings so far and keeps the winner. More rounds = better, slower.</p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1">Rounds <input type="number" min={1} max={40} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className="num w-16 rounded bg-slate-800 px-2 py-1 text-right" /></label>
          <button disabled={busy || n === 0} className={btn} onClick={() => run('/api/lab/optimize', { rounds })}>Start learning</button>
          {op?.status === 'running' && <button className={btn2} onClick={() => run('/api/lab/stop')}>Stop</button>}
        </div>
        {op?.status === 'running' && <p className="mt-2 text-sm text-sky-300">Round {op.rounds.length} of {op.totalRounds} · best net so far {rupee(op.rounds[op.rounds.length - 1]?.net ?? 0)}</p>}
        {op?.status === 'error' && <p className="mt-2 text-sm text-red-300">{op.message}</p>}
        {op && op.rounds.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
            {op.rounds.map((r) => <li key={r.round}>Round {r.round}: net {rupee(r.net)} ({r.trades} trades){r.change ? ` · kept: ${r.change}` : ' · nothing better'}</li>)}
          </ul>
        )}
        {op?.result && (
          <div className="mt-3 rounded-xl bg-slate-800/60 p-3 text-sm">
            <div>Before: net <b className={color(op.result.start.net)}>{rupee(op.result.start.net)}</b> ({op.result.start.trades} trades, {op.result.start.winRate}% won, {op.result.start.profitableDays}/{op.result.start.days} profitable days)</div>
            <div>After: net <b className={color(op.result.best.net)}>{rupee(op.result.best.net)}</b> ({op.result.best.trades} trades, {op.result.best.winRate}% won, {op.result.best.profitableDays}/{op.result.best.days} profitable days)</div>
            {op.result.changes.length === 0 ? <p className="mt-1 text-slate-400">Nothing better was found: your settings stay as they are.</p> : (
              <>
                <p className="mt-2 text-xs font-semibold text-slate-400">What it would change</p>
                <ul className="list-disc pl-5 text-xs">{op.result.changes.map((c) => <li key={c.name}>{c.name}: {c.from} → <b>{c.to}</b></li>)}</ul>
                <button className={`${btn} mt-2`} onClick={() => { if (confirm('Apply these settings to the live (paper) trader?')) call<{ changes: unknown[] }>('/api/lab/apply').then(() => setMsg('Applied. See Settings.')).catch((e: Error) => setMsg(e.message)); }}>Apply these settings</button>
                <p className="mt-1 text-[11px] text-amber-300">These were tuned on past days. They can be too fitted to them, so watch the paper results for a few days before trusting them.</p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function DataView({ days, reload }: { days?: Days; reload: () => void }) {
  const [msg, setMsg] = useState<string>();
  const imp = useLoop<{ status: string; message?: string }>('/api/lab/import', 2000);
  return (
    <div className="space-y-3">
      <section className={card}>
        <h3 className="font-semibold">Saved days</h3>
        <p className="mb-2 text-xs text-slate-500">The app saves every finished 1-minute candle of the Nifty 100 once a minute while the live market feed runs. These saved days are what the replay and the learner use.</p>
        {(days?.days ?? []).map((d) => <div key={d.day} className="flex justify-between border-t border-slate-800 py-1 text-sm"><span>{d.day}</span><span className="num text-slate-400">{d.symbols} shares · {d.candles} candles</span></div>)}
        {days?.days.length === 0 && <p className="text-sm text-slate-400">Nothing saved yet.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button className={btn2} onClick={() => call<{ shares: number }>('/api/lab/record').then((r) => { setMsg(`Saved today so far for ${r.shares} shares`); reload(); }).catch((e: Error) => setMsg(e.message))}>Save today now</button>
          <button className={btn} disabled={imp?.status === 'running'} onClick={() => call('/api/lab/import', { days: 10 }).then(() => setMsg('Import started')).catch((e: Error) => setMsg(e.message))}>Import the last 10 days</button>
          <button className={btn2} onClick={reload}>Refresh</button>
        </div>
        {imp && imp.status !== 'idle' && <p className="mt-2 text-sm text-sky-300">{imp.message}</p>}
        {msg && <p className="mt-2 text-sm text-slate-300">{msg}</p>}
        <p className="mt-2 text-[11px] text-slate-500">The import asks Upstox for earlier days and needs you to be logged in. If Upstox refuses it, the message above says why: the live days still build up by themselves.</p>
      </section>
    </div>
  );
}

export default function Lab() {
  const [sec, setSec] = useState<Section>('report');
  const [tick, setTick] = useState(0);
  const days = useLoop<Days>(`/api/lab/days?${tick}`, 20000);
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 overflow-x-auto">
        {([['report', 'Report'], ['replay', 'Replay'], ['learn', 'Learn'], ['data', 'Data']] as Array<[Section, string]>).map(([k, l]) => (
          <button key={k} onClick={() => setSec(k)} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${sec === k ? 'bg-sky-600' : 'bg-slate-800 text-slate-300'}`}>{l}</button>
        ))}
      </div>
      {sec === 'report' && <ReportView />}
      {sec === 'replay' && <ReplayView days={days} />}
      {sec === 'learn' && <LearnView days={days} />}
      {sec === 'data' && <DataView days={days} reload={() => setTick((t) => t + 1)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import Terminal from './Terminal.tsx';
import Picks from './Picks.tsx';
import Best from './Best.tsx';
import Settings from './Settings.tsx';
import { get, post, rupee, type EventRow, type Mover, type Status, type Trade } from './api.ts';

type Tab = 'trade' | 'auto' | 'best' | 'picks' | 'movers' | 'report' | 'settings';

interface Live { status: Status; movers: { gainers: Mover[]; losers: Mover[] } }

function useLive() {
  const [live, setLive] = useState<Live>();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => { setLive(JSON.parse(e.data)); setConnected(true); };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { live, connected };
}

const pnlColor = (n: number) => (n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-slate-300');

export default function App() {
  const { live, connected } = useLive();
  const [tab, setTab] = useState<Tab>('trade');
  const [symbol, setSymbol] = useState('RELIANCE');
  const [meta, setMeta] = useState<Status>();
  const [msg, setMsg] = useState<string>();

  useEffect(() => {
    get<Status>('/api/status').then(setMeta).catch(() => undefined);
    const t = setInterval(() => get<Status>('/api/status').then(setMeta).catch(() => undefined), 10000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setMsg(undefined); } catch (e) { setMsg((e as Error).message); }
    get<Status>('/api/status').then(setMeta).catch(() => undefined);
  };

  const s = live?.status;
  const openChart = (sym: string) => { setSymbol(sym); setTab('trade'); };

  return (
    <div className={`mx-auto p-2 pb-20 ${tab === 'trade' ? 'max-w-[1700px]' : 'max-w-3xl'}`}>
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-bold">Stock IQ</h1>
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded px-2 py-1 font-bold ${s?.mode === 'real' ? 'bg-red-600' : 'bg-sky-700'}`}>
            {s?.mode === 'real' ? 'REAL MONEY' : 'PAPER'}
          </span>
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} title={connected ? 'Live' : 'Offline'} />
          <span className="text-slate-400">{meta?.feed ?? ''}</span>
        </div>
      </header>

      {msg && <div className="mb-3 rounded bg-red-900/60 p-2 text-sm">{msg}</div>}
      {meta?.feedError && <div className="mb-3 rounded bg-amber-900/50 p-2 text-xs">Feed: {meta.feedError}</div>}

      {tab === 'trade' && <Terminal symbol={symbol} setSymbol={setSymbol} status={s} />}
      {tab === 'auto' && s && <Home s={s} meta={meta} act={act} openChart={openChart} />}
      {tab === 'best' && <Best onPick={openChart} real={s?.mode === 'real'} />}
      {tab === 'picks' && <Picks onPick={openChart} />}
      {tab === 'movers' && live && <Movers movers={live.movers} onPick={openChart} />}
      {tab === 'report' && <Trades />}
      {tab === 'settings' && (
        <div className="space-y-3">
          <Settings />
          <h2 className="pt-2 font-semibold">Activity log</h2>
          <Log />
        </div>
      )}
      {!s && tab === 'auto' && <p className="text-slate-400">Connecting to server…</p>}

      <nav className="fixed inset-x-0 bottom-0 flex border-t border-slate-800 bg-slate-950">
        {(['trade', 'auto', 'best', 'picks', 'movers', 'report', 'settings'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-3 text-xs capitalize ${tab === t ? 'text-sky-400' : 'text-slate-400'}`}>{t}</button>
        ))}
      </nav>
    </div>
  );
}

interface UniverseInfo { current: string; options: { id: string; name: string; count: number; warning?: string }[] }

function UniversePicker({ act, locked }: { act: (fn: () => Promise<unknown>) => void; locked: boolean }) {
  const [u, setU] = useState<UniverseInfo>();
  const load = () => get<UniverseInfo>('/api/universe').then(setU).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  if (!u) return null;
  const warning = u.options.find((o) => o.id === u.current)?.warning;
  return (
    <section className="rounded-lg bg-slate-900 p-3">
      <div className="mb-2 font-semibold">Share list (100 shares at a time)</div>
      <div className="grid grid-cols-3 gap-2">
        {u.options.map((o) => (
          <button key={o.id} disabled={locked}
            onClick={() => act(async () => { await post('/api/universe', { id: o.id }); await load(); })}
            className={`rounded py-2 text-sm disabled:opacity-40 ${u.current === o.id ? 'bg-sky-700 font-bold' : 'bg-slate-800'}`}>
            {o.id === 'large' ? 'Large' : o.id === 'mid' ? 'Mid' : 'Small'}
          </button>
        ))}
      </div>
      {locked && <p className="mt-2 text-xs text-slate-400">Close open positions to change the list.</p>}
      {warning && <p className="mt-2 text-xs text-amber-400">{warning}</p>}
    </section>
  );
}

function Home({ s, meta, act, openChart }: { s: Status; meta?: Status; act: (fn: () => Promise<unknown>) => void; openChart: (s: string) => void }) {
  const total = s.realizedToday + s.unrealized;
  const switchMode = () => {
    if (s.mode === 'real') return act(() => post('/api/mode', { mode: 'paper' }));
    const text = meta?.realConfirmText ?? '';
    const typed = window.prompt(`Switching to REAL money (brother's Upstox account).\nType exactly:\n${text}`);
    if (typed) act(() => post('/api/mode', { mode: 'real', confirm: typed }));
  };
  return (
    <div className="space-y-3">
      <section className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Today P&L" value={rupee(total)} cls={pnlColor(total)} />
        <Stat label="Booked" value={rupee(s.realizedToday)} cls={pnlColor(s.realizedToday)} />
        <Stat label="Free cash" value={rupee(s.freeCash)} />
      </section>

      <section className="rounded-lg bg-slate-900 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold">Auto trading</span>
          <span className={s.running ? 'text-green-400' : 'text-slate-400'}>{s.running ? 'Running' : 'Stopped'}</span>
        </div>
        {s.haltedReason && <p className="mb-2 text-sm text-amber-400">Stopped for today: {s.haltedReason}</p>}
        <div className="grid grid-cols-2 gap-2">
          {s.running ? (
            <button className="rounded bg-slate-700 py-2" onClick={() => act(() => post('/api/auto/stop'))}>Stop</button>
          ) : (
            <button className="rounded bg-green-700 py-2 disabled:opacity-40" disabled={!!s.haltedReason}
              onClick={() => act(() => post('/api/auto/start'))}>Start {s.mode}</button>
          )}
          <button className="rounded bg-red-700 py-2 font-bold"
            onClick={() => window.confirm('Sell ALL positions now and stop auto trading? You can press Start again any time.') && act(() => post('/api/kill-all'))}>
            KILL ALL
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-400">
            Real money: {s.realAllowed ? 'unlocked on server' : 'locked (server .env)'}
          </span>
          <button className="rounded bg-slate-800 px-3 py-1 disabled:opacity-40" disabled={!s.realAllowed && s.mode === 'paper'}
            onClick={switchMode}>
            Switch to {s.mode === 'real' ? 'paper' : 'real'}
          </button>
        </div>
        {meta && !meta.upstoxLoggedIn && (
          <a href="/api/auth/upstox/login" className="mt-3 block rounded bg-violet-700 py-2 text-center text-sm">Login to Upstox</a>
        )}
      </section>

      <UniversePicker act={act} locked={s.positions.length > 0} />

      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-2 font-semibold">Open positions ({s.positions.length}/{s.rules.maxOpenPositions})</h2>
        {s.positions.length === 0 && <p className="text-sm text-slate-400">None</p>}
        {s.positions.map((p) => (
          <div key={p.symbol} className="border-t border-slate-800 py-2 text-sm" onClick={() => openChart(p.symbol)}>
            <div className="flex justify-between">
              <span className="font-semibold">{p.symbol} × {p.qty} {p.side === 'short' && <span className="rounded bg-red-800 px-1 text-[10px] font-bold">SHORT</span>}</span>
              <span className={`num ${pnlColor(p.pnl)}`}>{rupee(p.pnl)}</span>
            </div>
            <div className="num flex justify-between text-slate-400">
              <span>In {p.entry}{p.estimated ? '*' : ''} · Now {p.ltp}</span>
              <span>Stop {p.stop}</span>
            </div>
            <div className="text-xs text-slate-500">{p.pattern}: {p.reason}</div>
          </div>
        ))}
      </section>

      <section className="rounded-lg bg-slate-900 p-3 text-xs text-slate-400">
        Rules: capital {rupee(s.rules.capital)} · risk/trade {rupee(s.rules.riskPerTrade)} · daily loss cap {rupee(s.rules.dailyLossCap)} ·
        max {s.rules.maxOpenPositions} open · skip if moved &gt; {s.rules.maxDayMovePct}% · square-off {s.rules.squareOffTime}
      </section>
    </div>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-slate-900 p-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`num font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Movers({ movers, onPick }: { movers: { gainers: Mover[]; losers: Mover[] }; onPick: (s: string) => void }) {
  const table = (title: string, rows: Mover[]) => (
    <section className="rounded-lg bg-slate-900 p-3">
      <h2 className="mb-2 font-semibold">{title}</h2>
      <table className="num w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="cursor-pointer border-t border-slate-800" onClick={() => onPick(r.symbol)}>
              <td className="py-1.5">{r.symbol}</td>
              <td className="text-right">{r.ltp.toFixed(2)}</td>
              <td className={`text-right ${pnlColor(r.changePct)}`}>{r.changePct > 0 ? '+' : ''}{r.changePct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {table('Top gainers', movers.gainers)}
      {table('Top losers', movers.losers)}
    </div>
  );
}

function Trades() {
  const [report, setReport] = useState<{ trades: Trade[]; count: number; wins: number; net: number; charges: number }>();
  useEffect(() => { get<typeof report>('/api/report/today').then(setReport).catch(() => undefined); }, []);
  if (!report) return <p className="text-slate-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <section className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Trades" value={`${report.count} (${report.wins} won)`} />
        <Stat label="Net" value={rupee(report.net)} cls={pnlColor(report.net)} />
        <Stat label="Charges" value={rupee(report.charges)} />
      </section>
      <section className="rounded-lg bg-slate-900 p-3">
        <h2 className="mb-2 font-semibold">Today's report: why each trade fired</h2>
        {report.trades.length === 0 && <p className="text-sm text-slate-400">No trades yet today.</p>}
        {report.trades.map((t) => (
          <div key={t.id} className="border-t border-slate-800 py-2 text-sm">
            <div className="flex justify-between">
              <span className="font-semibold">{t.symbol} × {t.qty} {t.side === 'short' && <span className="rounded bg-red-800 px-1 text-[10px] font-bold">SHORT</span>} <span className="text-xs text-slate-500">{t.mode}</span></span>
              <span className={`num ${pnlColor(t.net_pnl)}`}>{rupee(t.net_pnl)}</span>
            </div>
            <div className="num text-slate-400">{t.side === 'short' ? `sold ${t.entry_price} → bought back ${t.exit_price}` : `${t.entry_price} → ${t.exit_price}`} · charges {rupee(t.charges)}</div>
            <div className="text-xs text-slate-500">In: {t.entry_reason}</div>
            <div className="text-xs text-slate-500">Out: {t.exit_reason}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Log() {
  const [rows, setRows] = useState<EventRow[]>([]);
  useEffect(() => {
    const load = () => get<EventRow[]>('/api/events').then(setRows).catch(() => undefined);
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="space-y-1 rounded-lg bg-slate-900 p-3 text-xs">
      {rows.map((r) => (
        <div key={r.id} className={r.level === 'error' ? 'text-red-400' : r.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}>
          <span className="text-slate-500">{new Date(r.ts).toLocaleTimeString('en-IN')}</span> {r.message}
        </div>
      ))}
    </section>
  );
}

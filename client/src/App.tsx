import { useEffect, useState } from 'react';
import Terminal from './Terminal.tsx';
import Picks from './Picks.tsx';
import Best from './Best.tsx';
import Settings from './Settings.tsx';
import PositionCard from './Positions.tsx';
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

const NAV: [Tab, string, string][] = [
  ['trade', '📈', 'Trade'], ['auto', '🤖', 'Auto'], ['best', '⭐', 'Best'], ['picks', '🎯', 'Picks'],
  ['movers', '🔥', 'Movers'], ['report', '🧾', 'Report'], ['settings', '⚙️', 'Settings'],
];

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
    <div className={`mx-auto p-3 pb-24 ${tab === 'trade' ? 'max-w-[1700px]' : 'max-w-3xl'}`}>
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-600 text-sm font-black text-white shadow-lg shadow-sky-900/40">IQ</div>
          <div>
            <h1 className="text-lg font-extrabold leading-none tracking-tight">Stock <span className="text-sky-400">IQ</span></h1>
            <div className="mt-0.5 text-[10px] uppercase tracking-widest text-slate-500">Intraday · Nifty 100</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`rounded-full px-3 py-1 font-bold tracking-wide ${s?.mode === 'real' ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/40' : 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30'}`}>
            {s?.mode === 'real' ? 'REAL MONEY' : 'PAPER'}
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-slate-900 px-2.5 py-1 text-slate-400">
            <span className="relative flex h-2 w-2">
              {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-500'}`} />
            </span>
            {connected ? 'Live' : 'Offline'}{meta?.feed ? ` · ${meta.feed}` : ''}
          </span>
        </div>
      </header>

      {msg && <div className="mb-3 rounded bg-red-900/60 p-2 text-sm">{msg}</div>}
      <UpstoxBanner meta={meta} />

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

      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-slate-800 bg-slate-950/90 backdrop-blur">
        {NAV.map(([t, icon, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${tab === t ? 'text-sky-400' : 'text-slate-500 hover:text-slate-300'}`}>
            {tab === t && <span className="absolute inset-x-6 top-0 h-0.5 rounded-b bg-sky-400" />}
            <span className="text-base leading-none">{icon}</span>
            {label}
          </button>
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
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
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

/** Tells you plainly when live prices are missing and why, with a button to fix it. */
function UpstoxBanner({ meta }: { meta?: Status }) {
  if (!meta) return null;
  const state = meta.feedWanted === 'upstox' || meta.upstoxState === 'expired' ? meta.upstoxState : undefined;
  const login = (
    <a href="/api/auth/upstox/login" className="mt-2 inline-block rounded bg-violet-700 px-4 py-2 text-sm font-bold">Login with Upstox</a>
  );
  if (meta.feedWanted === 'upstox' && state === 'not_configured') {
    return (
      <div className="mb-3 rounded bg-amber-900/50 p-3 text-sm">
        Upstox keys are missing, so you are seeing <b>fake prices</b>. Put UPSTOX_API_KEY and UPSTOX_API_SECRET in the .env file, then restart the server.
      </div>
    );
  }
  if (state === 'expired') {
    return (
      <div className="mb-3 rounded bg-red-900/60 p-3 text-sm">
        <b>Your Upstox login expired.</b> Upstox logins end every day around 3:30 AM, so please log in again to get live prices.
        <div>{login}</div>
      </div>
    );
  }
  if (state === 'logged_out') {
    return (
      <div className="mb-3 rounded bg-amber-900/50 p-3 text-sm">
        Log in to Upstox to get live prices.
        <div>{login}</div>
      </div>
    );
  }
  return meta.feedError ? <div className="mb-3 rounded bg-amber-900/50 p-2 text-xs">Feed: {meta.feedError}</div> : null;
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
      <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 p-4">
        <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl ${total >= 0 ? 'bg-green-400/15' : 'bg-red-400/15'}`} />
        <div className="text-xs uppercase tracking-widest text-slate-500">Today's P&amp;L</div>
        <div className={`num mt-1 text-4xl font-extrabold tracking-tight ${pnlColor(total)}`}>{total > 0 ? '+' : ''}{rupee(total)}</div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="Booked" value={rupee(s.realizedToday)} cls={pnlColor(s.realizedToday)} />
          <Stat label="Open" value={rupee(s.unrealized)} cls={pnlColor(s.unrealized)} />
          <Stat label="Free cash" value={rupee(s.freeCash)} />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-semibold">Auto trading</span>
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.running ? 'bg-green-400/15 text-green-400' : 'bg-slate-800 text-slate-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${s.running ? 'animate-pulse bg-green-400' : 'bg-slate-500'}`} />
            {s.running ? 'Running' : 'Stopped'}
          </span>
        </div>
        {s.haltedReason && <p className="mb-3 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-400">Stopped for today: {s.haltedReason}</p>}
        <div className="grid grid-cols-2 gap-2">
          {s.running ? (
            <button className="rounded-xl bg-slate-800 py-2.5 font-semibold hover:bg-slate-700" onClick={() => act(() => post('/api/auto/stop'))}>Stop</button>
          ) : (
            <button className="rounded-xl bg-green-600 py-2.5 font-semibold shadow-lg shadow-green-900/30 hover:bg-green-500 disabled:opacity-40" disabled={!!s.haltedReason}
              onClick={() => act(() => post('/api/auto/start'))}>Start {s.mode}</button>
          )}
          <button className="rounded-xl bg-red-500/90 py-2.5 font-bold hover:bg-red-500"
            onClick={() => window.confirm('Sell ALL positions now and stop auto trading? You can press Start again any time.') && act(() => post('/api/kill-all'))}>
            KILL ALL
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-400">
            Real money: {s.realAllowed ? 'unlocked on server' : 'locked (server .env)'}
          </span>
          <button className="rounded-lg bg-slate-800 px-3 py-1 text-xs hover:bg-slate-700 disabled:opacity-40" disabled={!s.realAllowed && s.mode === 'paper'}
            onClick={switchMode}>
            Switch to {s.mode === 'real' ? 'paper' : 'real'}
          </button>
        </div>
        {meta && (meta.upstoxState === 'logged_out' || meta.upstoxState === 'expired') && (
          <a href="/api/auth/upstox/login" className="mt-3 block rounded bg-violet-700 py-2 text-center text-sm">Login with Upstox</a>
        )}
      </section>

      <UniversePicker act={act} locked={s.positions.length > 0} />

      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="font-semibold">Open positions</h2>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{s.positions.length}/{s.rules.maxOpenPositions}</span>
        </div>
        {s.positions.length === 0 && <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">No open positions. The bot only buys when every entry check passes.</p>}
        <div className="grid gap-2.5 sm:grid-cols-2">
          {s.positions.map((p) => (
            <PositionCard key={p.symbol} p={p} real={s.mode === 'real'} onOpen={() => openChart(p.symbol)}
              onClose={() => act(() => post(`/api/positions/${encodeURIComponent(p.symbol)}/close`))} />
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-500">
        Rules: capital {rupee(s.rules.capital)} · risk/trade {rupee(s.rules.riskPerTrade)} · daily loss cap {rupee(s.rules.dailyLossCap)} ·
        max {s.rules.maxOpenPositions} open · skip if moved &gt; {s.rules.maxDayMovePct}% · square-off {s.rules.squareOffTime}
      </section>
    </div>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-xl bg-slate-950/60 p-2.5 ring-1 ring-slate-800">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`num mt-0.5 text-sm font-bold ${cls}`}>{value}</div>
    </div>
  );
}

function Movers({ movers, onPick }: { movers: { gainers: Mover[]; losers: Mover[] }; onPick: (s: string) => void }) {
  const table = (title: string, rows: Mover[]) => (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
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
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
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
    <section className="space-y-1 rounded-2xl border border-slate-800 bg-slate-900 p-3 text-xs">
      {rows.map((r) => (
        <div key={r.id} className={r.level === 'error' ? 'text-red-400' : r.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}>
          <span className="text-slate-500">{new Date(r.ts).toLocaleTimeString('en-IN')}</span> {r.message}
        </div>
      ))}
    </section>
  );
}

import { useEffect, useState, type ReactNode } from 'react';

/** Shows a password screen when the server has APP_PASSWORD set and this browser is not logged in yet. */
export default function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'login' | 'ok'>('loading');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string>();

  const check = () =>
    fetch('/api/me').then((r) => r.json()).then((j: { authRequired: boolean; ok: boolean }) => setState(j.ok ? 'ok' : 'login')).catch(() => setState('ok'));
  useEffect(() => { void check(); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(undefined);
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    if (r.ok) { setPw(''); setState('ok'); } else setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not log in');
  };

  if (state === 'loading') return <p className="p-6 text-slate-400">Loading…</p>;
  if (state === 'ok') return <>{children}</>;
  return (
    <form onSubmit={submit} className="mx-auto mt-24 max-w-xs space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <h1 className="text-lg font-extrabold">Stock <span className="text-sky-400">IQ</span></h1>
      <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" className="w-full rounded bg-slate-800 px-3 py-2" />
      {err && <div className="rounded bg-red-900/60 p-2 text-sm">{err}</div>}
      <button className="w-full rounded bg-sky-700 py-2 font-bold">Log in</button>
    </form>
  );
}

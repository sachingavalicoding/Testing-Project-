import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/db.ts';
import type { PriceFeed } from '../market/feed.ts';
import type { MarketStore } from '../market/store.ts';
import type { AppSettings } from '../settings.ts';
import { UNIVERSES } from '../universe/index.ts';
import { ablation, clone, optimize, type AblationRow, type EvalResult, type OptimizeResult, type RoundLog } from './optimize.ts';
import { importHistory, recordStore } from './recorder.ts';
import { buildReport } from './report.ts';
import { ReplayRun, type DayData } from './replay.ts';

export interface LabDeps {
  db: Db;
  store: MarketStore;
  feed: PriceFeed;
  settings: { get(): AppSettings; update(input: unknown): AppSettings };
}

const LARGE = UNIVERSES.large.symbols;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Days with enough shares saved to be worth replaying, newest first. */
export function loadDays(db: Db, wanted?: string[], maxDays = 10): DayData[] {
  const ok = db.recordedDays().filter((d) => d.symbols >= 20 && d.candles >= d.symbols * 60);
  const days = (wanted?.length ? ok.filter((d) => wanted.includes(d.day)) : ok).slice(0, maxDays);
  return days.map((d) => ({ day: d.day, symbols: db.loadDay(d.day) })).reverse(); // oldest first
}

/** Copies only what the Lab may change from the learned settings onto the live ones. Everything else (cash, loss cap, scanner...) stays as it is. */
export function applyLearned(current: AppSettings, learned: AppSettings): AppSettings {
  const s = clone(current);
  s.entryChecks = { ...learned.entryChecks };
  s.lists.large.checks = { ...learned.lists.large.checks };
  s.minStopWidthPct = learned.minStopWidthPct;
  s.exitPlan = { ...learned.exitPlan };
  s.shortSelling = learned.shortSelling;
  s.requireAboveVwap = learned.requireAboveVwap;
  s.disabledPatterns = [...learned.disabledPatterns];
  return s;
}

interface Job<T> {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt?: number;
  message?: string;
  result?: T;
  stop?: boolean;
}

/** Plays one saved day at a chosen speed. A simulated minute lasts 60 s divided by the speed. 0 = as fast as possible. */
class ReplayController {
  run?: ReplayRun;
  speed = 10;
  paused = false;
  private token = 0;

  start(day: DayData, settings: AppSettings, speed: number): void {
    this.stop();
    this.run = new ReplayRun(day, settings);
    this.speed = speed;
    this.paused = false;
    void this.loop(++this.token);
  }

  stop(): void {
    this.token++;
    this.run?.db.close();
    this.run = undefined;
  }

  private async loop(token: number): Promise<void> {
    const run = this.run;
    if (!run) return;
    while (token === this.token && !run.finished) {
      if (this.paused) {
        await sleep(150);
        continue;
      }
      const t0 = Date.now();
      await run.stepMinute();
      if (token !== this.token) return;
      if (this.speed > 0) {
        const wait = 60_000 / this.speed - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
      } else await new Promise<void>((r) => setImmediate(r));
    }
  }

  state() {
    if (!this.run) return { active: false };
    return { active: true, speed: this.speed, paused: this.paused, ...this.run.snapshot() };
  }
}

export function registerLab(app: FastifyInstance, deps: LabDeps): void {
  const { db, store, feed } = deps;
  const fail = (msg: string) => ({ ok: false, error: msg });
  const replay = new ReplayController();

  // ----- the report -----
  app.get<{ Querystring: { days?: string; mode?: string } }>('/api/lab/report', async (req) => {
    const n = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    let trades = db.allTrades(10000);
    if (req.query.mode === 'paper' || req.query.mode === 'real') trades = trades.filter((t) => t.mode === req.query.mode);
    const keep = new Set([...new Set(trades.map((t) => t.day))].sort().reverse().slice(0, n));
    return buildReport(trades.filter((t) => keep.has(t.day)));
  });

  // ----- saved candles -----
  app.get('/api/lab/days', async () => ({ days: db.recordedDays(), learnable: loadDays(db).map((d) => d.day) }));

  app.post('/api/lab/record', async () => ({ ok: true, shares: recordStore(db, store, LARGE) }));

  const importJob: Job<{ shares: number; days: number; failed: number }> = { status: 'idle' };
  app.post<{ Body: { days?: number } }>('/api/lab/import', async (req, reply) => {
    if (importJob.status === 'running') return reply.code(400).send(fail('An import is already running'));
    const days = Math.min(30, Math.max(2, Number(req.body?.days ?? 10)));
    importJob.status = 'running';
    importJob.message = `Fetching about ${days} days for ${LARGE.length} shares…`;
    importJob.result = undefined;
    void importHistory(feed, db, LARGE, days, { log: (m) => db.log('warn', m) })
      .then((r) => { importJob.status = 'done'; importJob.result = r; importJob.message = `Saved ${r.days} days for ${r.shares} shares${r.failed ? ` (${r.failed} shares failed)` : ''}`; })
      .catch((e: Error) => { importJob.status = 'error'; importJob.message = e.message; });
    return { ok: true };
  });
  app.get('/api/lab/import', async () => importJob);

  // ----- replay a saved day -----
  app.post<{ Body: { day?: string; speed?: number } }>('/api/lab/replay', async (req, reply) => {
    const day = req.body?.day;
    if (!day) return reply.code(400).send(fail('Pick a day'));
    const data = db.loadDay(day);
    if (data.size < 20) return reply.code(400).send(fail('That day has too few saved shares to replay'));
    const speed = [0, 1, 2, 5, 10, 25, 50].includes(Number(req.body?.speed)) ? Number(req.body?.speed) : 10;
    replay.start({ day, symbols: data }, deps.settings.get(), speed);
    return { ok: true };
  });
  app.post<{ Body: { action: 'pause' | 'resume' | 'stop' | 'speed'; speed?: number } }>('/api/lab/replay/control', async (req, reply) => {
    const { action, speed } = req.body ?? ({} as never);
    if (action === 'pause') replay.paused = true;
    else if (action === 'resume') replay.paused = false;
    else if (action === 'stop') replay.stop();
    else if (action === 'speed' && [0, 1, 2, 5, 10, 25, 50].includes(Number(speed))) replay.speed = Number(speed);
    else return reply.code(400).send(fail('Unknown control'));
    return { ok: true };
  });
  app.get('/api/lab/replay', async () => replay.state());

  // ----- which checks earn money (ablation) and the learner (optimize) -----
  let heavy: 'ablation' | 'optimize' | undefined;
  const ablationJob: Job<{ base: EvalResult; rows: AblationRow[] }> & { done?: number; total?: number } = { status: 'idle' };
  const optJob: Job<OptimizeResult> & { rounds: RoundLog[]; totalRounds: number; days: number } = { status: 'idle', rounds: [], totalRounds: 0, days: 0 };

  app.post('/api/lab/ablation', async (_req, reply) => {
    if (heavy) return reply.code(400).send(fail(`The ${heavy} test is still running`));
    const days = loadDays(db);
    if (days.length === 0) return reply.code(400).send(fail('No saved days to test yet. Record or import days first'));
    heavy = 'ablation';
    Object.assign(ablationJob, { status: 'running', startedAt: Date.now(), result: undefined, stop: false, message: undefined, done: 0, total: 0 });
    void ablation(days, deps.settings.get(), (d, t) => { ablationJob.done = d; ablationJob.total = t; }, () => !!ablationJob.stop)
      .then((r) => { ablationJob.status = 'done'; ablationJob.result = r; })
      .catch((e: Error) => { ablationJob.status = 'error'; ablationJob.message = e.message; })
      .finally(() => { heavy = undefined; });
    return { ok: true, days: days.length };
  });
  app.get('/api/lab/ablation', async () => ablationJob);

  app.post<{ Body: { rounds?: number; variants?: number } }>('/api/lab/optimize', async (req, reply) => {
    if (heavy) return reply.code(400).send(fail(`The ${heavy} test is still running`));
    const days = loadDays(db);
    if (days.length === 0) return reply.code(400).send(fail('No saved days to learn from yet. Record or import days first'));
    const rounds = Math.min(40, Math.max(1, Number(req.body?.rounds ?? 12)));
    const variants = Math.min(20, Math.max(2, Number(req.body?.variants ?? 6)));
    heavy = 'optimize';
    Object.assign(optJob, { status: 'running', startedAt: Date.now(), result: undefined, stop: false, message: undefined, rounds: [], totalRounds: rounds, days: days.length });
    void optimize(days, deps.settings.get(), { rounds, variants, shouldStop: () => !!optJob.stop, onRound: (log) => { optJob.rounds.push(log); } })
      .then((r) => { optJob.status = 'done'; optJob.result = r; })
      .catch((e: Error) => { optJob.status = 'error'; optJob.message = e.message; })
      .finally(() => { heavy = undefined; });
    return { ok: true, days: days.length };
  });
  app.get('/api/lab/optimize', async () => ({ ...optJob, result: optJob.result ? { ...optJob.result, settings: undefined } : undefined }));
  app.post('/api/lab/stop', async () => { ablationJob.stop = true; optJob.stop = true; return { ok: true }; });

  app.post('/api/lab/apply', async (_req, reply) => {
    const learned = optJob.result;
    if (!learned) return reply.code(400).send(fail('Nothing learned yet'));
    if (learned.changes.length === 0) return reply.code(400).send(fail('The learner found nothing better than your current settings'));
    return { ok: true, settings: deps.settings.update(applyLearned(deps.settings.get(), learned.settings)), changes: learned.changes };
  });
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const COOKIE = 'siq';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * A single shared password for the whole app (set APP_PASSWORD in .env). Without it anyone who can reach the port can press
 * Buy, Kill All and read your Upstox login, so it MUST be set on any server that is reachable from the internet.
 * Everything under /api (and the Upstox callback page) needs the login cookie; only the web app files and /api/login and /api/me are public.
 */
export function registerAuth(app: FastifyInstance, password: string | undefined): void {
  if (!password) {
    app.get('/api/me', async () => ({ authRequired: false, ok: true }));
    return;
  }
  const token = createHmac('sha256', password).update('stock-iq-session').digest('hex');
  const authed = (req: FastifyRequest) => {
    const c = cookieOf(req, COOKIE);
    return c !== undefined && same(c, token);
  };
  const fails = new Map<string, { n: number; until: number }>();

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const guarded = path.startsWith('/api/') || path === '/upstox/callback';
    if (!guarded || path === '/api/login' || path === '/api/me') return;
    if (!authed(req)) return reply.code(401).send({ ok: false, error: 'login required' });
  });

  app.get('/api/me', async (req) => ({ authRequired: true, ok: authed(req) }));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && f.until > Date.now()) return reply.code(429).send({ ok: false, error: 'Too many wrong passwords. Wait a minute.' });
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!same(createHmac('sha256', 'cmp').update(given).digest('hex'), createHmac('sha256', 'cmp').update(password).digest('hex'))) {
      const n = (f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      return reply.code(401).send({ ok: false, error: 'Wrong password' });
    }
    fails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}`);
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });
}

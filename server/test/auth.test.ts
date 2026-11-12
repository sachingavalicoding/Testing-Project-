import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerAuth } from '../src/auth.ts';

async function build(pw?: string) {
  const app = Fastify();
  registerAuth(app, pw);
  app.get('/api/secret', async () => ({ secret: 1 }));
  app.get('/upstox/callback', async () => ({ cb: 1 }));
  app.get('/index.html', async () => 'page');
  await app.ready();
  return app;
}

describe('app password', () => {
  it('is open when no password is set', async () => {
    const app = await build();
    expect((await app.inject({ url: '/api/secret' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me' })).json()).toEqual({ authRequired: false, ok: true });
  });

  it('locks the api and the Upstox callback, but not the web app files', async () => {
    const app = await build('hunter2');
    expect((await app.inject({ url: '/api/secret' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/upstox/callback?code=x' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/index.html' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me' })).json()).toEqual({ authRequired: true, ok: false });
  });

  it('rejects a wrong password and accepts the right one with a cookie', async () => {
    const app = await build('hunter2');
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0];
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect((await app.inject({ url: '/api/secret', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().ok).toBe(true);
    expect((await app.inject({ url: '/api/secret', headers: { cookie: 'siq=forged' } })).statusCode).toBe(401);
  });

  it('slows down guessing after 5 wrong passwords', async () => {
    const app = await build('hunter2');
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'x' } });
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'hunter2' } })).statusCode).toBe(429);
  });
});

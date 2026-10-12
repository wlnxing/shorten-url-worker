import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from './env';

const COOKIE = '__Host-short_session';
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function decode(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
async function key(env: Env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    throw new HTTPException(503, {
      message: '请先配置 ADMIN_PASSWORD 和至少 32 字符的 SESSION_SECRET',
    });
  // Changing either secret invalidates all previously issued sessions.
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`${env.SESSION_SECRET}\0${env.ADMIN_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin)
      throw new HTTPException(403, { message: '仅允许同源操作' });
    if (!c.req.header('Content-Type')?.startsWith('application/json'))
      throw new HTTPException(415, { message: '请求须使用 application/json' });
  }
  await next();
};
export const authenticated: MiddlewareHandler<AppEnv> = async (c, next) => {
  const signingKey = await key(c.env);
  try {
    const token = getCookie(c, COOKIE) ?? '';
    if (token.length > 1024) throw new Error('Invalid session');
    const [body, signature, extra] = token.split('.');
    if (
      !body ||
      !signature ||
      extra ||
      !(await crypto.subtle.verify('HMAC', signingKey, decode(signature), encoder.encode(body)))
    )
      throw new Error('Invalid session');
    const payload = JSON.parse(new TextDecoder().decode(decode(body))) as {
      exp: number;
      v: number;
    };
    if (payload.v !== 1 || !Number.isFinite(payload.exp) || payload.exp <= Date.now())
      throw new Error('Expired session');
  } catch {
    throw new HTTPException(401, { message: '请先登录，或重新登录已过期的会话' });
  }
  await next();
};
export const auth = new Hono<AppEnv>();
auth.post('/login', async (c) => {
  const signingKey = await key(c.env);
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (!(await c.env.LOGIN_LIMITER.limit({ key: `login:${ip}` })).success) {
    c.header('Retry-After', '60');
    throw new HTTPException(429, { message: '登录尝试过于频繁，请一分钟后重试' });
  }
  const body = await c.req.json<{ password?: unknown }>();
  if (typeof body.password !== 'string')
    throw new HTTPException(400, { message: '请输入管理员密码' });
  const expected = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(c.env.ADMIN_PASSWORD)),
  );
  const actual = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(body.password)),
  );
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  if (difference) throw new HTTPException(401, { message: '密码不正确' });
  const payload = base64(
    encoder.encode(
      JSON.stringify({
        v: 1,
        exp: Date.now() + SESSION_SECONDS * 1000,
        nonce: crypto.randomUUID(),
      }),
    ),
  );
  const signature = base64(
    new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, encoder.encode(payload))),
  );
  setCookie(c, COOKIE, `${payload}.${signature}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  return c.json({ ok: true });
});
auth.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { secure: true, path: '/' });
  return c.json({ ok: true });
});
auth.get('/session', authenticated, (c) => c.json({ authenticated: true }));

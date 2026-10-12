import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { auth, authenticated, sameOrigin } from './auth';
import { links } from './links';
import { stats } from './stats';
import { redirect } from './redirect';
import { runMaintenance } from './archive';
import type { AppEnv, Env } from './env';

export const app = new Hono<AppEnv>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
app.use(
  '/api/*',
  bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: '请求内容过大' }, 413) }),
);
app.use('/api/*', sameOrigin);
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const body: unknown = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new HTTPException(400, { message: '请求内容须为 JSON 对象' });
    }
  }
  await next();
});
app.route('/api/auth', auth);
app.use('/api/admin/*', authenticated);
app.route('/api/admin/links', links);
app.route('/api/admin', stats);
app.all('/s/*', redirect);
app.all('/s', (c) => c.text('短链不存在', 404, { 'Cache-Control': 'no-store' }));
app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  c.header('Cache-Control', 'no-store');
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return c.json({ error: 'JSON 格式无效' }, 400);
  console.error('request_failed', error.message);
  return c.json({ error: '服务暂时不可用，请稍后重试' }, 503);
});

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runMaintenance(env)
        .then((action) => {
          console.log('maintenance', action);
        })
        .catch((error) => {
          console.error(
            'maintenance_failed',
            error instanceof Error ? error.message : 'Unknown error',
          );
          throw error;
        }),
    );
  },
} satisfies ExportedHandler<Env>;

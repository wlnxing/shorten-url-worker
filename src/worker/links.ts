import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './env';
import type { Link } from '../shared/types';
import { bad, positiveInt, randomSlug, validSlug, validTarget } from './validation';
import { invalidate } from './redirect';

export const links = new Hono<AppEnv>();
links.get('/', async (c) => {
  const page = positiveInt(c.req.query('page'), 1, 100000);
  const size = positiveInt(c.req.query('size'), 20, 100);
  const query = (c.req.query('q') ?? '').slice(0, 256).replace(/[\\%_]/g, '\\$&');
  const includeDeleted = c.req.query('includeDeleted') === 'true';
  const condition = `${includeDeleted ? '1=1' : 'deleted_at IS NULL'} AND (slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')`;
  const values = [`%${query}%`, `%${query}%`, `%${query}%`];
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM links WHERE ${condition} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    ).bind(...values, size, (page - 1) * size),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM links WHERE ${condition}`).bind(...values),
  ]);
  return c.json({
    items: rows.results,
    total: (count.results[0] as { total: number }).total,
    page,
    size,
  });
});
links.get('/:id', async (c) => {
  const link = await c.env.DB.prepare('SELECT * FROM links WHERE id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id'))
    .first<Link>();
  if (!link) throw new HTTPException(404, { message: '短链不存在' });
  return c.json(link);
});
function fields(body: Record<string, unknown>, origin: string) {
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 120))
    bad('标题最多 120 字符');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') bad('启用状态须为布尔值');
  return {
    target: validTarget(body.target, origin),
    title: String(body.title ?? '').trim(),
    enabled: body.enabled === false ? 0 : 1,
  };
}
links.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const origin = new URL(c.req.url).origin;
  const values = fields(body, origin);
  const custom = body.slug !== undefined && body.slug !== '';
  const chosen = custom ? validSlug(body.slug) : '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = custom ? chosen : randomSlug();
    const now = Date.now();
    const link: Link = {
      id: crypto.randomUUID(),
      slug,
      ...values,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    try {
      await c.env.DB.prepare(
        'INSERT INTO links(id, slug, target, title, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(link.id, slug, values.target, values.title, values.enabled, now, now)
        .run();
      c.executionCtx.waitUntil(invalidate(origin, [slug]).catch(() => {}));
      return c.json(link, 201);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('UNIQUE constraint failed: links.slug')
      )
        throw error;
      if (custom) throw new HTTPException(409, { message: '该短链路径已被使用' });
    }
  }
  throw new HTTPException(503, { message: '自动生成短码失败，请重试' });
});
links.put('/:id', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const origin = new URL(c.req.url).origin;
  const slug = validSlug(body.slug);
  const values = fields(body, origin);
  const old = await c.env.DB.prepare('SELECT * FROM links WHERE id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id'))
    .first<Link>();
  if (!old) throw new HTTPException(404, { message: '短链不存在' });
  try {
    const updated = await c.env.DB.prepare(
      'UPDATE links SET slug = ?, target = ?, title = ?, enabled = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *',
    )
      .bind(slug, values.target, values.title, values.enabled, Date.now(), old.id)
      .first<Link>();
    if (!updated) throw new HTTPException(404, { message: '短链已被删除' });
    c.executionCtx.waitUntil(invalidate(origin, [old.slug, slug]).catch(() => {}));
    return c.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: links.slug'))
      throw new HTTPException(409, { message: '该短链路径已被使用' });
    throw error;
  }
});
links.delete('/:id', async (c) => {
  const removed = await c.env.DB.prepare(
    'UPDATE links SET deleted_at = ?, updated_at = ?, enabled = 0 WHERE id = ? AND deleted_at IS NULL RETURNING slug',
  )
    .bind(Date.now(), Date.now(), c.req.param('id'))
    .first<{ slug: string }>();
  if (!removed) throw new HTTPException(404, { message: '短链不存在' });
  c.executionCtx.waitUntil(invalidate(new URL(c.req.url).origin, [removed.slug]).catch(() => {}));
  return c.json({ ok: true });
});

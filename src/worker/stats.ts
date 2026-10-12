import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ArchiveDay, ArchivePart, Breakdown, DailyStat, Visit } from '../shared/types';
import {
  config,
  DAY,
  dayOf,
  dayStart,
  earliestDay,
  HOT_DAYS,
  hotCutoff,
  published,
  type AppEnv,
} from './env';
import { bad, dateRange, positiveInt, validDay } from './validation';

export const stats = new Hono<AppEnv>();
const unarchived = `NOT EXISTS (SELECT 1 FROM archive_days a WHERE a.day = strftime('%Y-%m-%d', e.occurred_at / 1000, 'unixepoch') AND a.status IN ${published})`;

stats.get('/status', async (c) => {
  const cfg = config(c.env);
  const [state, count] = await c.env.DB.batch([
    c.env.DB.prepare(
      'SELECT last_run_at, last_success_at, last_action, last_error FROM maintenance WHERE id = 1',
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM events e WHERE occurred_at < ? AND ${unarchived}`,
    ).bind(hotCutoff()),
  ]);
  return c.json({
    ...cfg,
    hotDays: HOT_DAYS,
    today: dayOf(Date.now()),
    earliestDay: earliestDay(c.env),
    maintenance: state.results[0],
    backlog: (count.results[0] as { count: number }).count,
  });
});
stats.get('/stats', async (c) => {
  const range = dateRange(c.env, c.req.query('from'), c.req.query('to'));
  const linkId = c.req.query('linkId') ?? '';
  if (linkId.length > 64) bad('短链 ID 无效');
  const where = `e.occurred_at >= ? AND e.occurred_at < ? ${linkId ? 'AND e.link_id = ?' : ''} AND ${unarchived}`;
  const values: (string | number)[] = [range.start, range.end, ...(linkId ? [linkId] : [])];
  const group = (column: string) =>
    c.env.DB.prepare(
      `SELECT ${column} AS name, COUNT(*) AS count FROM events e WHERE ${where} GROUP BY ${column} ORDER BY count DESC`,
    ).bind(...values);
  // A single D1 batch pins the source routing and hot aggregates to one transaction.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM archive_days WHERE day >= ? AND day <= ? AND status IN ${published} ORDER BY day`,
    ).bind(range.from, range.to),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch') AS day, COUNT(*) AS pv, COUNT(DISTINCT visitor_key) AS uv FROM events e WHERE ${where} GROUP BY day ORDER BY day`,
    ).bind(...values),
    group('country'),
    group('referer'),
    group('browser'),
    group('device'),
  ]);
  return c.json({
    from: range.from,
    to: range.to,
    archives: results[0].results as unknown as ArchiveDay[],
    daily: results[1].results as unknown as DailyStat[],
    countries: results[2].results as unknown as Breakdown[],
    referers: results[3].results as unknown as Breakdown[],
    browsers: results[4].results as unknown as Breakdown[],
    devices: results[5].results as unknown as Breakdown[],
  });
});
stats.get('/stats/events', async (c) => {
  const day = validDay(c.req.query('day') ?? dayOf(Date.now()));
  dateRange(c.env, day, day);
  const size = positiveInt(c.req.query('size'), 50, 100);
  const linkId = c.req.query('linkId') ?? '';
  if (linkId.length > 64) bad('短链 ID 无效');
  let cursorTime = dayStart(day) + DAY,
    cursorId = Number.MAX_SAFE_INTEGER;
  if (c.req.query('cursor')) {
    const parts = c.req.query('cursor')!.split(':').map(Number);
    if (parts.length !== 2 || parts.some((v) => !Number.isSafeInteger(v) || v < 0))
      bad('分页游标无效');
    [cursorTime, cursorId] = parts;
  }
  const [source, events] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT day FROM archive_days WHERE day = ? AND status IN ${published}`).bind(
      day,
    ),
    c.env.DB.prepare(
      `SELECT e.* FROM events e WHERE occurred_at >= ? AND occurred_at < ? AND (occurred_at, id) < (?, ?) ${linkId ? 'AND link_id = ?' : ''} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    ).bind(
      dayStart(day),
      dayStart(day) + DAY,
      cursorTime,
      cursorId,
      ...(linkId ? [linkId] : []),
      size + 1,
    ),
  ]);
  if (source.results.length)
    throw new HTTPException(409, { message: '该日数据已归档，请重新加载归档数据' });
  const rows = events.results as unknown as Visit[];
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  const last = items[items.length - 1];
  return c.json({ items, nextCursor: hasMore ? `${last.occurred_at}:${last.id}` : null });
});
stats.get('/archives', async (c) => {
  const page = positiveInt(c.req.query('page'), 1, 10000);
  const days = await c.env.DB.prepare(
    'SELECT * FROM archive_days WHERE day >= ? ORDER BY day DESC LIMIT 50 OFFSET ?',
  )
    .bind(earliestDay(c.env), (page - 1) * 50)
    .all<ArchiveDay>();
  return c.json({ items: days.results });
});
stats.get('/archives/:day', async (c) => {
  const day = validDay(c.req.param('day'));
  if (day < earliestDay(c.env)) throw new HTTPException(410, { message: '归档已超过保留期限' });
  const after = c.req.query('after') ? positiveInt(c.req.query('after'), 0, 1_000_000) : 0;
  const [source, parts] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT * FROM archive_days WHERE day = ? AND status IN ${published}`).bind(
      day,
    ),
    c.env.DB.prepare(
      "SELECT * FROM archive_parts WHERE day = ? AND status = 'ready' AND part >= ? ORDER BY part LIMIT 101",
    ).bind(day, after),
  ]);
  if (!source.results.length) throw new HTTPException(404, { message: '归档尚未发布或不存在' });
  const rows = parts.results as unknown as ArchivePart[];
  return c.json({
    day: source.results[0],
    parts: rows.slice(0, 100),
    next: rows.length > 100 ? rows[100].part : null,
  });
});
stats.get('/archives/:day/parts/:part', async (c) => {
  const day = validDay(c.req.param('day'));
  if (day < earliestDay(c.env)) throw new HTTPException(410, { message: '归档已超过保留期限' });
  const number = Number(c.req.param('part'));
  if (!Number.isSafeInteger(number) || number < 0) bad('分片编号无效');
  const part = await c.env.DB.prepare(
    `SELECT p.* FROM archive_parts p JOIN archive_days d ON p.day = d.day WHERE p.day = ? AND p.part = ? AND p.status = 'ready' AND d.status IN ${published}`,
  )
    .bind(day, number)
    .first<ArchivePart>();
  if (!part) throw new HTTPException(404, { message: '归档分片不存在' });
  const object = await c.env.ARCHIVES.get(part.id);
  if (!object) throw new HTTPException(503, { message: '归档对象暂时不可用，请稍后重试' });
  c.header('Content-Type', 'application/gzip');
  c.header('X-Content-SHA256', part.sha256);
  c.header('Content-Length', String(object.size));
  // Do not set Content-Encoding: the browser worker explicitly decompresses gzip.
  return c.body(object.body);
});

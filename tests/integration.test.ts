import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHmac } from 'node:crypto';
import type { Visit } from '../src/shared/types';

const ORIGIN = 'https://short.example';
const DAY = 86400000;
const today = new Date().toISOString().slice(0, 10);
const start = Date.parse(`${today}T00:00:00Z`);
const oldDay = new Date(start - 15 * DAY).toISOString().slice(0, 10);
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let cookie: string;

// Test-only wrapper: fault injection and the scheduled handler are not exposed by the deployed worker.
const testEntry = `
import worker from './src/worker/index.ts';
import { runMaintenance } from './src/worker/archive.ts';
import { mappingKey } from './src/worker/redirect.ts';
export default { async fetch(request, bindings) {
  const env = { ...bindings };
  env.MODE = request.headers.get('X-Test-Mode') ?? env.MODE;
  env.ARCHIVE_BATCH_SIZE = request.headers.get('X-Test-Batch') ?? env.ARCHIVE_BATCH_SIZE;
  env.ARCHIVE_MAX_KB = request.headers.get('X-Test-Max-KB') ?? env.ARCHIVE_MAX_KB;
  env.STATS_RETENTION_DAYS = request.headers.get('X-Test-Retention') ?? env.STATS_RETENTION_DAYS;
  env.ADMIN_PASSWORD = request.headers.get('X-Test-Password') ?? env.ADMIN_PASSWORD;
  const fault = request.headers.get('X-Test-Fault');
  let calls = 0;
  env.DB = new Proxy(bindings.DB, { get(target, name) {
    if (name === 'prepare') return (sql) => { calls++; if (fault === 'read-db' || (fault === 'write-event' && sql.startsWith('INSERT INTO events'))) throw new Error('Injected D1 error'); return target.prepare(sql); };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  }});
  if (fault?.startsWith('r2-')) env.ARCHIVES = new Proxy(bindings.ARCHIVES, { get(target, name) {
    if (name === 'put') return async (...args) => { if (fault === 'r2-put') throw new Error('Injected R2 failure'); await target.put(...args); throw new Error('Interrupted after upload'); };
    const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
  }});
  const url = new URL(request.url);
  if (url.pathname === '/__test/maintenance') {
    try { return Response.json({ action: await runMaintenance(env) }); }
    catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
  }
  if (url.pathname === '/__test/cache') {
    const value = await request.json();
    await caches.default.put(mappingKey(url.origin, value.slug), Response.json(value.mapping, { headers: { 'Cache-Control': 'public, max-age=60' } }));
    return Response.json({ ok: true });
  }
  const pending = [];
  const response = await worker.fetch(request, env, { waitUntil: p => pending.push(p), passThroughOnException() {}, props: {} });
  await Promise.all(pending);
  const result = new Response(response.body, response);
  result.headers.set('X-Test-Db-Calls', String(calls));
  return result;
}};
`;
beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: testEntry, resolveDir: process.cwd() },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-01',
      d1Databases: ['DB'],
      r2Buckets: ['ARCHIVES'],
      bindings: {
        MODE: 'economy',
        STATS_RETENTION_DAYS: '180',
        ARCHIVE_BATCH_SIZE: '500',
        ADMIN_PASSWORD: 'integration-test-password',
        SESSION_SECRET: 'integration-signature-secret-with-more-than-32-characters',
      },
      ratelimits: { LOGIN_LIMITER: { namespace_id: '1001', simple: { limit: 5, period: 60 } } },
      serviceBindings: { ASSETS: () => new Response('not found', { status: 404 }) },
    }),
  );
  db = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('ARCHIVES');
  const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  await db.batch(
    sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  const login = await mf.dispatchFetch(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify({ password: 'integration-test-password' }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await db.batch(
    ['archive_parts', 'archive_days', 'events', 'links'].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
  await db
    .prepare(
      'UPDATE maintenance SET token = NULL, locked_until = 0, last_error = NULL, last_action = NULL',
    )
    .run();
  const objects = await bucket.list();
  if (objects.objects.length) await bucket.delete(objects.objects.map((object) => object.key));
});
async function call(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: ORIGIN,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
}
async function create(
  slug = `test-${crypto.randomUUID()}`,
  target = 'https://example.org/path?kept=1',
) {
  const res = await call('/api/admin/links', 'POST', {
    slug,
    target,
    title: 'Test',
  });
  expect(res.status).toBe(201);
  return res.json<{ id: string; slug: string; target: string; title: string; enabled: number }>();
}
async function seed(count: number, at = start - 15 * DAY + 1000, id = 'historic-link') {
  await db
    .prepare(
      `WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < ?)
    INSERT INTO events(link_id, slug, hostname, query, occurred_at, ip, country, region, city, referer, ua, browser, device, visitor_key)
    SELECT ?, 'campaign/summer', 'short.example', '', ? + x, '192.0.2.' || (x % 7), 'CN', 'Shanghai', 'Shanghai', 'example.org', 'Mozilla/5.0 Chrome/130.0 Mobile', 'Chrome', '手机', 'visitor-' || (x % 7) FROM seq`,
    )
    .bind(count, id, at)
    .run();
}
async function maintenance(headers: Record<string, string> = {}) {
  return call('/__test/maintenance', 'POST', {}, headers);
}
async function drain(limit = 72, headers: Record<string, string> = {}) {
  const actions: string[] = [];
  for (let i = 0; i < limit; i++) {
    const result = await maintenance(headers);
    expect(result.status, await result.clone().text()).toBe(200);
    const { action } = await result.json<{ action: string }>();
    actions.push(action);
    if (action === 'idle') break;
  }
  return actions;
}

describe('authentication and link management', () => {
  it('rejects expired signed sessions and invalid JSON shapes', async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() - 1000 })).toString(
      'base64url',
    );
    const signature = createHmac(
      'sha256',
      'integration-signature-secret-with-more-than-32-characters\0integration-test-password',
    )
      .update(payload)
      .digest('base64url');
    expect(
      (
        await call('/api/admin/status', 'GET', undefined, {
          Cookie: `__Host-short_session=${payload}.${signature}`,
        })
      ).status,
    ).toBe(401);
    for (const body of [null, [], 'string', 1]) {
      expect((await call('/api/admin/links', 'POST', body)).status).toBe(400);
    }
  });
  it('protects APIs, rejects cross-origin writes, and invalidates rotated sessions', async () => {
    expect((await mf.dispatchFetch(`${ORIGIN}/api/admin/links`)).status).toBe(401);
    expect(
      (await call('/api/admin/links', 'POST', {}, { Origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect(
      (await call('/api/admin/status', 'GET', undefined, { 'X-Test-Password': 'changed' })).status,
    ).toBe(401);
    const res = await call('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
  it('limits password attempts', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await call(
            '/api/auth/login',
            'POST',
            { password: 'wrong' },
            { 'CF-Connecting-IP': '192.0.2.200' },
          )
        ).status,
      ).toBe(401);
    const limited = await call(
      '/api/auth/login',
      'POST',
      { password: 'wrong' },
      { 'CF-Connecting-IP': '192.0.2.200' },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });
  it('supports multi-level paths, uniqueness, automatic codes, pagination and escaped search', async () => {
    const link = await create('campaign/summer');
    expect(
      (await call('/api/admin/links', 'POST', { slug: link.slug, target: link.target })).status,
    ).toBe(409);
    const automatic = await call('/api/admin/links', 'POST', { target: 'https://example.org' });
    expect((await automatic.json<{ slug: string }>()).slug).toMatch(/^[a-zA-Z0-9]{8}$/);
    const list = await (
      await call('/api/admin/links?size=1')
    ).json<{ items: unknown[]; total: number }>();
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(2);
    expect((await (await call('/api/admin/links?q=%25')).json<{ total: number }>()).total).toBe(0);
  });
  it('rejects invalid paths, unsupported targets, loops and oversized payloads', async () => {
    for (const slug of ['a//b', '../x', 'a/%2Fb', '中文', '/start', 'end/'])
      expect(
        (await call('/api/admin/links', 'POST', { slug, target: 'https://example.org' })).status,
      ).toBe(400);
    for (const target of [
      'javascript:alert(1)',
      'ftp://example.org',
      'https://user:pass@example.org',
      `${ORIGIN}/s/another`,
    ])
      expect((await call('/api/admin/links', 'POST', { target })).status).toBe(400);
    expect((await call('/api/admin/links', 'POST', { target: 'x'.repeat(9000) })).status).toBe(413);
  });
  it('retains stable history through rename, disable and deletion; reused paths get a new identity', async () => {
    const link = await create();
    await seed(1, Date.now() - 1000, link.id);
    expect(
      (
        await call(`/api/admin/links/${link.id}`, 'PUT', {
          ...link,
          slug: 'renamed/path',
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect((await call('/s/renamed/path')).status).toBe(404);
    expect((await call(`/api/admin/links/${link.id}`, 'DELETE', {})).status).toBe(200);
    const replacement = await create('renamed/path');
    expect(replacement.id).not.toBe(link.id);
    expect(
      (await db.prepare('SELECT link_id FROM events').first<{ link_id: string }>())?.link_id,
    ).toBe(link.id);
    expect((await (await call('/api/admin/links')).json<{ total: number }>()).total).toBe(1);
  });
});

describe('redirect modes and cache', () => {
  it('performs zero storage calls on an economy cache hit while forwarding request queries', async () => {
    const link = await create();
    const cold = await call(`/s/${link.slug}?campaign=first`);
    expect(cold.headers.get('x-test-db-calls')).toBe('1');
    expect(cold.headers.get('Location')).toBe(`${link.target}&campaign=first`);
    const hit = await call(`/s/${link.slug}?injected=2`, 'GET', undefined, {
      'X-Test-Fault': 'read-db',
    });
    expect(hit.status).toBe(302);
    expect(hit.headers.get('Location')).toBe(`${link.target}&injected=2`);
    expect(hit.headers.get('x-test-db-calls')).toBe('0');
    expect(hit.headers.get('Cache-Control')).toBe('no-store');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      0,
    );
  });
  const rawQuery = 'tag=one&tag=two&name=a%20b&plus=a+b&slash=%2f&flag&empty=';
  it.each([
    { target: 'https://example.org/path', expected: `https://example.org/path?${rawQuery}` },
    {
      target: 'https://example.org/path#details',
      expected: `https://example.org/path?${rawQuery}#details`,
    },
    {
      target: 'https://example.org/path?#details',
      expected: `https://example.org/path?${rawQuery}#details`,
    },
    {
      target: 'https://example.org/path?tag=target&kept=a%20b&slash=%2f#details',
      expected: `https://example.org/path?tag=target&kept=a%20b&slash=%2f&${rawQuery}#details`,
    },
  ])(
    'appends raw queries to $target for GET and HEAD in both modes',
    async ({ target, expected }) => {
      const link = await create(undefined, target);
      for (const mode of ['economy', 'detailed']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await call(`/s/${link.slug}?${rawQuery}`, method, undefined, {
            'X-Test-Mode': mode,
          });
          expect(response.status).toBe(302);
          expect(response.headers.get('Location')).toBe(expected);
        }
      }
      const { results } = await db.prepare('SELECT query FROM events').all();
      expect(results).toEqual([{ query: rawQuery }]);
      const plain = await call(`/s/${link.slug}`, 'GET', undefined, { 'X-Test-Fault': 'read-db' });
      expect(plain.headers.get('Location')).toBe(target);
      expect(plain.headers.get('x-test-db-calls')).toBe('0');
    },
  );
  it('records every detailed GET including cache hits, excludes HEAD, and counts daily UV', async () => {
    const link = await create();
    const headers = {
      'X-Test-Mode': 'detailed',
      'CF-Connecting-IP': '192.0.2.8',
      'User-Agent': 'Mozilla Chrome/130.0 Mobile',
      Referer: 'https://ref.example/private?token=secret',
    };
    await call(`/s/${link.slug}`, 'GET', undefined, headers);
    await call(`/s/${link.slug}`, 'GET', undefined, headers);
    await call(`/s/${link.slug}`, 'HEAD', undefined, headers);
    const stats = await (
      await call(`/api/admin/stats?from=${today}&to=${today}`)
    ).json<{ daily: { pv: number; uv: number }[] }>();
    expect(stats.daily[0]).toMatchObject({ pv: 2, uv: 1 });
    const event = await db
      .prepare('SELECT hostname, query, ip, referer FROM events LIMIT 1')
      .first();
    expect(event).toEqual({
      hostname: 'short.example',
      query: '',
      ip: '192.0.2.8',
      referer: 'ref.example',
    });
    await call(`/s/${link.slug}`, 'GET');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      2,
    );
  });
  it('preserves each request hostname and query across cache hits, event queries and archiving', async () => {
    const link = await create(`domains/${crypto.randomUUID()}`);
    const hosts = [
      { origin: ORIGIN, hostname: 'short.example' },
      { origin: 'https://Another.example:8443', hostname: 'another.example' },
    ];
    for (const { origin } of hosts) {
      for (let visit = 0; visit < 2; visit++) {
        const query = `campaign=summer&visit=${visit}&${rawQuery}`;
        const res = await mf.dispatchFetch(`${origin}/s/${link.slug}?${query}`, {
          headers: {
            'X-Test-Mode': 'detailed',
            'CF-Connecting-IP': '192.0.2.9',
            Referer: 'https://ref.example/page',
            'X-Forwarded-Host': 'forwarded.example',
            Forwarded: 'host=forwarded.example',
          },
          redirect: 'manual',
        });
        expect(res.status).toBe(302);
        expect(res.headers.get('Location')).toBe(`${link.target}&${query}`);
        expect(res.headers.get('x-test-db-calls')).toBe(visit === 0 ? '2' : '1');
      }
    }
    const response = await call(`/api/admin/stats/events?day=${today}&linkId=${link.id}`);
    expect(response.status).toBe(200);
    const { items } = await response.json<{ items: Visit[] }>();
    expect(items).toHaveLength(4);
    for (const { hostname } of hosts) {
      const matches = items.filter((event) => event.hostname === hostname);
      expect(matches).toHaveLength(2);
      expect(matches.map((event) => event.query).sort()).toEqual([
        `campaign=summer&visit=0&${rawQuery}`,
        `campaign=summer&visit=1&${rawQuery}`,
      ]);
      expect(
        matches.every((event) => event.slug === link.slug && event.referer === 'ref.example'),
      ).toBe(true);
    }

    await db
      .prepare('UPDATE events SET occurred_at = ? + id')
      .bind(start - 15 * DAY)
      .run();
    await drain();
    const archived = await call(`/api/admin/archives/${oldDay}/parts/0`);
    expect(archived.status).toBe(200);
    const rows: Visit[] = gunzipSync(Buffer.from(await archived.arrayBuffer()))
      .toString()
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line));
    expect(rows.map(({ id, hostname, query }) => ({ id, hostname, query }))).toEqual(
      [...items].reverse().map(({ id, hostname, query }) => ({ id, hostname, query })),
    );
  });
  it('rejects null and omitted hostnames when persisting visits', async () => {
    await seed(1);
    await expect(db.prepare('UPDATE events SET hostname = NULL').run()).rejects.toThrow(
      'NOT NULL constraint failed: events.hostname',
    );
    await expect(
      db
        .prepare(
          `INSERT INTO events(link_id, slug, query, occurred_at, ip, country, region, city, referer, ua, browser, device, visitor_key)
        SELECT link_id, slug, query, occurred_at, ip, country, region, city, referer, ua, browser, device, visitor_key FROM events`,
        )
        .run(),
    ).rejects.toThrow('NOT NULL constraint failed: events.hostname');
  });
  it('continues redirects on statistics failure, but reports a cold D1 outage', async () => {
    const link = await create();
    expect(
      (
        await call(`/s/${link.slug}`, 'GET', undefined, {
          'X-Test-Mode': 'detailed',
          'X-Test-Fault': 'write-event',
          'CF-Connecting-IP': '192.0.2.8',
        })
      ).status,
    ).toBe(302);
    expect(
      (await call('/s/not-cached', 'GET', undefined, { 'X-Test-Fault': 'read-db' })).status,
    ).toBe(503);
  });
  it('rejects expired absolute mappings even if an edge cache entry was reinserted', async () => {
    const link = await create();
    await call('/__test/cache', 'POST', {
      slug: link.slug,
      mapping: { link: { ...link, target: 'https://stale.example' }, validUntil: Date.now() - 1 },
    });
    const response = await call(`/s/${link.slug}`);
    expect(response.headers.get('Location')).toBe(link.target);
    expect(response.headers.get('x-test-db-calls')).toBe('1');
    expect((await call(`/s/${link.slug}`, 'POST', {})).status).toBe(405);
    expect((await call('/s/bad%2Fpath')).status).toBe(404);
  });
});

describe('resumable archives and retention', () => {
  it('defaults the size limit to 512 KB and rejects invalid limits before archiving', async () => {
    expect(await (await call('/api/admin/status')).json()).toMatchObject({
      archiveMaxKb: 512,
    });
    for (const maxKb of [16, 16384]) {
      const status = await call('/api/admin/status', 'GET', undefined, {
        'X-Test-Max-KB': String(maxKb),
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ archiveMaxKb: maxKb });
    }
    await seed(1);
    for (const value of ['0', '-1', '15', '16385', '512.5', 'NaN', 'Infinity']) {
      const result = await maintenance({ 'X-Test-Max-KB': value });
      expect(result.status, `Invalid ARCHIVE_MAX_KB: ${value}`).toBe(503);
      expect(await result.json()).toEqual({
        error: 'ARCHIVE_MAX_KB must be 16..16384 (1 KB = 1024 bytes)',
      });
    }
    expect((await bucket.list()).objects).toHaveLength(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      1,
    );
  });
  it.each([
    { maxKb: 16, count: 24 },
    { maxKb: 1024, count: 501 },
  ])('archives UTF-8 records within a $maxKb-KB limit without loss', async ({ maxKb, count }) => {
    await seed(count);
    const ua = '归档'.repeat(256);
    await db.prepare('UPDATE events SET ua = ?').bind(ua).run();
    const expected = await db
      .prepare('SELECT id FROM events ORDER BY occurred_at, id')
      .all<{ id: number }>();
    const actions = await drain(72, { 'X-Test-Max-KB': String(maxKb) });
    expect(actions.at(-1)).toBe('idle');
    const objects = (await bucket.list()).objects;
    expect(objects.length).toBeGreaterThan(1);
    const ids: number[] = [];
    for (const [index, object] of objects.entries()) {
      const stored = (await bucket.get(object.key))!;
      const raw = gunzipSync(Buffer.from(await stored.arrayBuffer()));
      expect(raw.byteLength).toBeLessThanOrEqual(maxKb * 1024);
      const [header, ...rows] = raw
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(header).toEqual({ schemaVersion: 1, day: oldDay });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(500);
      expect(rows.every((row) => row.ua === ua)).toBe(true);
      if (maxKb === 1024 && index === 0) {
        expect(raw.byteLength).toBeGreaterThan(512 * 1024);
        expect(rows).toHaveLength(500);
      }
      ids.push(...rows.map((row) => row.id));
    }
    expect(ids).toEqual(expected.results.map((row) => row.id));
    expect(await db.prepare('SELECT row_count, status FROM archive_days').first()).toEqual({
      row_count: count,
      status: 'cleaned',
    });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      0,
    );
  });
  it('does not delete source rows until the complete UTC day is published', async () => {
    await seed(3);
    await maintenance({ 'X-Test-Batch': '2' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      3,
    );
    expect((await call(`/api/admin/archives/${oldDay}`)).status).toBe(404);
    await maintenance({ 'X-Test-Batch': '2' });
    await maintenance(); // Publish, still retaining D1 rows.
    const stats = await (
      await call(`/api/admin/stats?from=${oldDay}&to=${oldDay}`)
    ).json<{ archives: unknown[]; daily: unknown[] }>();
    expect(stats.archives).toHaveLength(1);
    expect(stats.daily).toHaveLength(0);
    expect((await call(`/api/admin/stats/events?day=${oldDay}`)).status).toBe(409);
    const res = await call(`/api/admin/archives/${oldDay}/parts/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.has('content-encoding')).toBe(false);
    const lines = gunzipSync(Buffer.from(await res.arrayBuffer()))
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ schemaVersion: 1, day: oldDay });
    expect(lines[1].ip).toBe('192.0.2.1');
    expect(lines).toHaveLength(3);
    await maintenance();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      0,
    );
    expect((await mf.dispatchFetch(`${ORIGIN}/api/admin/archives/${oldDay}/parts/0`)).status).toBe(
      401,
    );
  });
  it('recovers failed and interrupted uploads after both row and byte limits shrink', async () => {
    await seed(16);
    await db.prepare('UPDATE events SET ua = ?').bind('归档'.repeat(256)).run();
    expect(
      (
        await maintenance({
          'X-Test-Fault': 'r2-put',
          'X-Test-Batch': '12',
          'X-Test-Max-KB': '32',
        })
      ).status,
    ).toBe(503);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      16,
    );
    const smallerLimits = { 'X-Test-Batch': '1', 'X-Test-Max-KB': '16' };
    expect((await maintenance({ 'X-Test-Fault': 'r2-after-put', ...smallerLimits })).status).toBe(
      503,
    );
    const objects = (await bucket.list()).objects;
    expect(objects).toHaveLength(1);
    const pendingObject = (await bucket.get(objects[0].key))!;
    expect(gunzipSync(Buffer.from(await pendingObject.arrayBuffer())).byteLength).toBeGreaterThan(
      16384,
    );
    expect((await maintenance(smallerLimits)).status).toBe(200);
    await drain(72, smallerLimits);
    const day = await db
      .prepare('SELECT * FROM archive_days')
      .first<{ row_count: number; part_count: number; status: string }>();
    expect(day).toMatchObject({ row_count: 16, part_count: 5, status: 'cleaned' });
    expect((await bucket.list()).objects).toHaveLength(5);
  });
  it('stops on checksum mismatch and resumes after an expired lease', async () => {
    await seed(1);
    await maintenance({ 'X-Test-Fault': 'r2-after-put' });
    const object = (await bucket.list()).objects[0];
    await bucket.put(object.key, 'corrupt', { customMetadata: { sha256: 'bad' } });
    expect((await maintenance()).status).toBe(503);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      1,
    );
    await db
      .prepare('UPDATE maintenance SET token = ?, locked_until = ?')
      .bind('another-run', Date.now() + 60000)
      .run();
    expect(await (await maintenance()).json()).toEqual({ action: 'locked' });
    await db.prepare('UPDATE maintenance SET locked_until = 0').run();
    await bucket.delete(object.key);
    expect((await maintenance()).status).toBe(200);
  });
  it('archives only complete days older than 14 days and expires data using configurable retention', async () => {
    await seed(1, start - 14 * DAY - 2);
    await seed(1, start - 14 * DAY);
    await drain();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      1,
    );
    const archived = await db.prepare('SELECT day FROM archive_days').first<{ day: string }>();
    expect(
      (
        await call(`/api/admin/archives/${archived!.day}`, 'GET', undefined, {
          'X-Test-Retention': '15',
        })
      ).status,
    ).toBe(410);
    await maintenance({ 'X-Test-Retention': '15' });
    await maintenance({ 'X-Test-Retention': '15' });
    expect((await bucket.list()).objects).toHaveLength(0);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM archive_parts').first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it('finishes a 10,000-visit day with room inside 72 twenty-minute invocations', async () => {
    await seed(10000);
    const actions = await drain(72);
    expect(actions.at(-1)).toBe('idle');
    expect(actions.length).toBeLessThan(50);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n).toBe(
      0,
    );
    expect(
      await db.prepare('SELECT row_count, part_count, status FROM archive_days').first(),
    ).toEqual({ row_count: 10000, part_count: 20, status: 'cleaned' });
    expect((await bucket.list()).objects).toHaveLength(20);
  }, 90000);
});

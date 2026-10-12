import type { Context } from 'hono';
import { CACHE_SECONDS, config, type AppEnv } from './env';
import { validSlug } from './validation';
import { recordVisit } from './visits';
import type { Link } from '../shared/types';

interface Mapping {
  link: Pick<Link, 'id' | 'slug' | 'target'> | null;
  validUntil: number;
}
export function mappingKey(origin: string, slug: string) {
  return new Request(`${origin}/__internal_mapping_v1/${slug}`);
}
export async function invalidate(origin: string, slugs: string[]) {
  await Promise.all(slugs.map((slug) => caches.default.delete(mappingKey(origin, slug))));
}
export async function redirect(c: Context<AppEnv>) {
  c.header('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    c.header('Allow', 'GET, HEAD');
    return c.text('Method not allowed', 405);
  }
  const url = new URL(c.req.url);
  const slug = url.pathname.slice(3);
  try {
    validSlug(slug);
  } catch {
    return c.text('短链不存在或已停用', 404);
  }
  const { mode } = config(c.env);
  const cacheKey = mappingKey(url.origin, slug);
  let mapping: Mapping | undefined;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const value = await cached.json<Mapping>();
      if (value.validUntil > Date.now()) mapping = value;
    }
  } catch {
    /* A cache outage must not break the source-of-truth lookup. */
  }
  if (!mapping) {
    const lookupStarted = Date.now();
    let link: Mapping['link'];
    try {
      link = await c.env.DB.prepare(
        'SELECT id, slug, target FROM links WHERE slug = ? AND deleted_at IS NULL AND enabled = 1',
      )
        .bind(slug)
        .first();
    } catch (error) {
      console.error('link_lookup_failed', error instanceof Error ? error.message : 'D1 error');
      return c.text('短链服务暂时不可用，请稍后重试', 503);
    }
    mapping = { link, validUntil: lookupStarted + (link ? CACHE_SECONDS : 10) * 1000 };
    const remaining = Math.floor((mapping.validUntil - Date.now()) / 1000);
    if (remaining > 0)
      c.executionCtx.waitUntil(
        caches.default
          .put(
            cacheKey,
            Response.json(mapping, {
              headers: { 'Cache-Control': `public, max-age=${remaining}` },
            }),
          )
          .catch(() => {}),
      );
  }
  if (!mapping.link) return c.text('短链不存在或已停用', 404);
  if (mode === 'detailed' && c.req.method === 'GET') {
    c.executionCtx.waitUntil(
      recordVisit(c.env, c.req.raw, mapping.link).catch((error) => {
        console.error('visit_write_failed', error instanceof Error ? error.message : 'D1 error');
      }),
    );
  }
  c.header('Location', mapping.link.target);
  return c.body(null, 302);
}

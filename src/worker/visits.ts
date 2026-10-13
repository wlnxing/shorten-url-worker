import type { Env } from './env';
import type { Link } from '../shared/types';

export function agentInfo(ua: string) {
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Firefox\//i.test(ua)
      ? 'Firefox'
      : /(?:Chrome|CriOS)\//i.test(ua)
        ? 'Chrome'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : '其他';
  const device = /bot|crawler|spider|headless/i.test(ua)
    ? '机器人'
    : /iPad|Tablet/i.test(ua)
      ? '平板'
      : /Mobile|Android|iPhone/i.test(ua)
        ? '手机'
        : '桌面';
  return { browser, device };
}
export async function recordVisit(
  env: Env,
  request: Request,
  link: Pick<Link, 'id' | 'slug'>,
  occurredAt = Date.now(),
) {
  const url = new URL(request.url);
  const ua = (request.headers.get('User-Agent') ?? '').slice(0, 512);
  const ip = (request.headers.get('CF-Connecting-IP') ?? '').slice(0, 45);
  let referer = '';
  try {
    referer = new URL(request.headers.get('Referer') ?? '').hostname.slice(0, 253);
  } catch {
    /* Direct visit. */
  }
  const cf = request.cf;
  const country = String(cf?.country ?? '').slice(0, 8);
  const region = String(cf?.region ?? '').slice(0, 80);
  const city = String(cf?.city ?? '').slice(0, 80);
  const { browser, device } = agentInfo(ua);
  const visitor = ip
    ? Array.from(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}\0${ua}`)),
        ),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('')
    : null;
  await env.DB.prepare(
    `INSERT INTO events(link_id, slug, hostname, query, occurred_at, ip, country, region, city, referer, ua, browser, device, visitor_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      link.id,
      link.slug,
      url.hostname,
      url.search.slice(1),
      occurredAt,
      ip,
      country,
      region,
      city,
      referer,
      ua,
      browser,
      device,
      visitor,
    )
    .run();
}

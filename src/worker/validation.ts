import { HTTPException } from 'hono/http-exception';
import { DAY, dayOf, dayStart, earliestDay, type Env } from './env';

export function bad(message: string): never {
  throw new HTTPException(400, { message });
}
export function validSlug(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > 256 ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(input)
  ) {
    return bad('短链路径仅支持字母、数字、-、_ 和分层 /，总长不超过 256 字符');
  }
  return input;
}
export function validTarget(input: unknown, origin: string) {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\x7f]/.test(input))
    return bad('请输入有效的 HTTP/HTTPS 目标网址（最多 2048 字符）');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return bad('请输入完整的目标网址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    return bad('目标网址仅支持 HTTP/HTTPS，且不能包含账号密码');
  if (url.origin === origin && (url.pathname === '/s' || url.pathname.startsWith('/s/')))
    return bad('目标不能是本站短链，避免循环跳转');
  return url.href;
}
export function validDay(input: string | undefined): string {
  if (
    !input ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
    !Number.isFinite(dayStart(input)) ||
    dayOf(dayStart(input)) !== input
  )
    return bad('日期格式应为 YYYY-MM-DD');
  return input;
}
export function dateRange(env: Env, from?: string, to?: string) {
  const now = Date.now();
  const end = validDay(to ?? dayOf(now));
  const start = validDay(from ?? dayOf(now - 6 * DAY));
  if (start > end || end > dayOf(now) || dayStart(end) - dayStart(start) > 365 * DAY)
    return bad('日期范围须为过去最多 366 天');
  const effective = start < earliestDay(env, now) ? earliestDay(env, now) : start;
  if (effective > end) return bad('所选统计已超过保留期限');
  return { from: effective, to: end, start: dayStart(effective), end: dayStart(end) + DAY };
}
export function positiveInt(value: string | undefined, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return bad('分页参数无效');
  return parsed;
}
export function randomSlug() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  // Rejection sampling avoids modulo bias.
  while (out.length < 8) {
    for (const n of crypto.getRandomValues(new Uint8Array(16))) {
      if (n < 248 && out.length < 8) out += alphabet[n % 62];
    }
  }
  return out;
}

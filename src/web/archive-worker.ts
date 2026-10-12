import type { ArchiveDay, ArchivePart, Breakdown, Stats, Visit } from '../shared/types';

type Job =
  | { kind: 'stats'; days: ArchiveDay[]; linkId: string }
  | { kind: 'events'; day: string; linkId: string; page: number };
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<Job>) => void) | null;
  postMessage: (message: unknown) => void;
};
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '无法读取归档');
  return data as T;
}
async function manifest(day: string) {
  const parts: ArchivePart[] = [];
  let next: number | null = 0;
  while (next !== null) {
    const data: { parts: ArchivePart[]; next: number | null } = await json(
      `/api/admin/archives/${day}${next ? `?after=${next}` : ''}`,
    );
    parts.push(...data.parts);
    next = data.next;
  }
  return parts;
}
async function readPart(part: ArchivePart): Promise<Visit[]> {
  const response = await fetch(`/api/admin/archives/${part.day}/parts/${part.part}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error((await response.json()).error ?? '归档读取失败');
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== part.sha256 || bytes.byteLength !== part.byte_count)
    throw new Error('归档校验失败，请重新加载');
  const text = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).text();
  const lines = text.trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  if (header.schemaVersion !== 1 || header.day !== part.day) throw new Error('不支持的归档格式');
  const rows = lines.map((line) => JSON.parse(line) as Visit);
  if (rows.length !== part.row_count) throw new Error('归档记录数校验失败');
  return rows;
}
function increment(map: Map<string, number>, value: string) {
  map.set(value, (map.get(value) ?? 0) + 1);
}
function breakdown(map: Map<string, number>): Breakdown[] {
  return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

async function execute(job: Job) {
  if (job.kind === 'events') {
    const parts = (await manifest(job.day)).reverse();
    const items: Visit[] = [];
    let matched = 0;
    for (const part of parts) {
      for (const row of (await readPart(part)).reverse()) {
        if (job.linkId && row.link_id !== job.linkId) continue;
        if (matched++ >= (job.page - 1) * 50) items.push(row);
        if (items.length === 51) return { items: items.slice(0, 50), hasMore: true };
      }
    }
    return { items, hasMore: false };
  }
  const countries = new Map<string, number>(),
    referers = new Map<string, number>();
  const browsers = new Map<string, number>(),
    devices = new Map<string, number>();
  const daily: Stats['daily'] = [];
  const total = job.days.reduce((sum, day) => sum + day.part_count, 0);
  let completed = 0;
  for (const day of job.days) {
    // Only one date's deduplication sets are retained, even for long history ranges.
    const visitors = new Set<string>(),
      seen = new Set<number>();
    let pv = 0;
    for (const part of await manifest(day.day)) {
      for (const row of await readPart(part)) {
        if ((job.linkId && row.link_id !== job.linkId) || seen.has(row.id)) continue;
        seen.add(row.id);
        pv++;
        if (row.visitor_key) visitors.add(row.visitor_key);
        increment(countries, row.country);
        increment(referers, row.referer);
        increment(browsers, row.browser);
        increment(devices, row.device);
      }
      worker.postMessage({
        type: 'progress',
        value: Math.round((++completed / Math.max(total, 1)) * 100),
        day: day.day,
      });
    }
    daily.push({ day: day.day, pv, uv: visitors.size });
  }
  return {
    daily,
    countries: breakdown(countries),
    referers: breakdown(referers),
    browsers: breakdown(browsers),
    devices: breakdown(devices),
  } satisfies Stats;
}
worker.onmessage = (event) => {
  execute(event.data)
    .then((result) => worker.postMessage({ type: 'done', result }))
    .catch((error) =>
      worker.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : '归档读取失败',
      }),
    );
};

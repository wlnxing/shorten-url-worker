import type { ArchiveDay, ArchivePart, Visit } from '../shared/types';
import { config, DAY, dayOf, dayStart, earliestDay, hotCutoff, type Env } from './env';

const encoder = new TextEncoder();
const EVENT_COLUMNS =
  'id, link_id, slug, occurred_at, ip, country, region, city, referer, ua, browser, device, visitor_key';
const guard = 'EXISTS (SELECT 1 FROM maintenance WHERE id = 1 AND token = ? AND locked_until > ?)';
function owned(token: string) {
  return [token, Date.now()];
}
function assertChanged(result: D1Result) {
  if (result.meta.changes !== 1) throw new Error('Maintenance lease lost');
}
function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (n) => n.toString(16).padStart(2, '0')).join('');
}

async function encode(day: string, rows: Visit[], maxBytes: number) {
  const lines = [JSON.stringify({ schemaVersion: 1, day })];
  let bytes = encoder.encode(lines[0]).byteLength + 1;
  let count = 0;
  for (const row of rows) {
    const line = JSON.stringify(row);
    const length = encoder.encode(line).byteLength + 1;
    if (bytes + length > maxBytes) break;
    lines.push(line);
    bytes += length;
    count++;
  }
  if (!count) throw new Error('An archive event exceeds the chunk size limit');
  const stream = new Blob([lines.join('\n') + '\n'])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(stream).arrayBuffer();
  const sha256 = hex(await crypto.subtle.digest('SHA-256', compressed));
  return { compressed, sha256, rows: rows.slice(0, count) };
}

async function uploadStep(env: Env, day: ArchiveDay, token: string, now: number) {
  const { archiveBatchSize, archiveMaxKb } = config(env);
  let part = await env.DB.prepare(
    "SELECT * FROM archive_parts WHERE day = ? AND status = 'pending' ORDER BY part LIMIT 1",
  )
    .bind(day.day)
    .first<ArchivePart>();
  let rows: Visit[];
  if (part) {
    // Reserved boundaries survive changes to both row and byte limits between retries.
    const result = await env.DB.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
      WHERE (occurred_at, id) >= (?, ?) AND (occurred_at, id) <= (?, ?) ORDER BY occurred_at, id LIMIT 500`,
    )
      .bind(part.first_time, part.first_id, part.last_time, part.last_id)
      .all<Visit>();
    rows = result.results;
    if (rows.length !== part.row_count)
      throw new Error('Archive source rows changed; deletion has been stopped');
  } else {
    const result = await env.DB.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
      WHERE occurred_at >= ? AND occurred_at < ? AND (occurred_at, id) > (?, ?)
      ORDER BY occurred_at, id LIMIT ?`,
    )
      .bind(
        dayStart(day.day),
        dayStart(day.day) + DAY,
        day.cursor_time,
        day.cursor_id,
        archiveBatchSize,
      )
      .all<Visit>();
    rows = result.results;
    if (!rows.length) {
      assertChanged(
        await env.DB.prepare(
          `UPDATE archive_days SET status = 'published', published_at = ?
        WHERE day = ? AND status = 'uploading' AND ${guard}
        AND NOT EXISTS (SELECT 1 FROM archive_parts WHERE day = ? AND status != 'ready')`,
        )
          .bind(now, day.day, ...owned(token), day.day)
          .run(),
      );
      return `published:${day.day}`;
    }
  }
  // Pending parts must reproduce the complete reserved payload, even after limits shrink.
  // Their source query remains bounded to 500 rows and the checksum verifies its contents.
  const payload = await encode(day.day, rows, part ? Infinity : archiveMaxKb * 1024);
  rows = payload.rows;
  if (part) {
    if (part.sha256 !== payload.sha256 || part.row_count !== rows.length)
      throw new Error('Archive checksum differs from the reserved chunk');
  } else {
    const first = rows[0],
      last = rows[rows.length - 1];
    part = {
      id: `analytics/v1/${day.day.replaceAll('-', '/')}/part-${String(day.part_count).padStart(6, '0')}.jsonl.gz`,
      day: day.day,
      part: day.part_count,
      status: 'pending',
      first_time: first.occurred_at,
      first_id: first.id,
      last_time: last.occurred_at,
      last_id: last.id,
      row_count: rows.length,
      byte_count: payload.compressed.byteLength,
      sha256: payload.sha256,
    };
    assertChanged(
      await env.DB.prepare(
        `INSERT INTO archive_parts
      (id, day, part, status, first_time, first_id, last_time, last_id, row_count, byte_count, sha256)
      SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
      )
        .bind(
          part.id,
          part.day,
          part.part,
          part.first_time,
          part.first_id,
          part.last_time,
          part.last_id,
          part.row_count,
          part.byte_count,
          part.sha256,
          ...owned(token),
        )
        .run(),
    );
  }

  const existing = await env.ARCHIVES.head(part.id);
  if (existing) {
    if (existing.customMetadata?.sha256 !== part.sha256 || existing.size !== part.byte_count)
      throw new Error('Existing R2 archive failed checksum validation');
  } else {
    const uploaded = await env.ARCHIVES.put(part.id, payload.compressed, {
      sha256: part.sha256,
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/gzip', cacheControl: 'private, no-store' },
      customMetadata: { sha256: part.sha256, rows: String(part.row_count), schemaVersion: '1' },
      storageClass: 'Standard',
    });
    if (!uploaded) throw new Error('Archive upload raced with another invocation; retry required');
  }

  const lease = owned(token);
  const committed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE archive_parts SET status = 'ready' WHERE id = ? AND status = 'pending' AND ${guard}`,
    ).bind(part.id, ...lease),
    env.DB.prepare(
      `UPDATE archive_days SET cursor_time = ?, cursor_id = ?, part_count = part_count + 1,
      row_count = row_count + ?, byte_count = byte_count + ?
      WHERE day = ? AND status = 'uploading' AND part_count = ? AND ${guard}
      AND EXISTS (SELECT 1 FROM archive_parts WHERE id = ? AND status = 'ready')`,
    ).bind(
      part.last_time,
      part.last_id,
      part.row_count,
      part.byte_count,
      part.day,
      part.part,
      ...lease,
      part.id,
    ),
  ]);
  committed.forEach(assertChanged);
  return `uploaded:${part.day}:${part.part}:${part.row_count}`;
}

async function expireArchive(env: Env, day: ArchiveDay, token: string) {
  assertChanged(
    await env.DB.prepare(`UPDATE archive_days SET status = 'deleting' WHERE day = ? AND ${guard}`)
      .bind(day.day, ...owned(token))
      .run(),
  );
  const parts = await env.DB.prepare(
    'SELECT id FROM archive_parts WHERE day = ? ORDER BY part LIMIT 100',
  )
    .bind(day.day)
    .all<{ id: string }>();
  if (parts.results.length) {
    await env.ARCHIVES.delete(parts.results.map((part) => part.id));
    await env.DB.prepare(
      `DELETE FROM archive_parts WHERE id IN (SELECT id FROM archive_parts WHERE day = ? ORDER BY part LIMIT 100) AND ${guard}`,
    )
      .bind(day.day, ...owned(token))
      .run();
  } else {
    await env.DB.prepare(`DELETE FROM archive_days WHERE day = ? AND ${guard}`)
      .bind(day.day, ...owned(token))
      .run();
  }
  return `expired:${day.day}:${parts.results.length}`;
}

async function step(env: Env, token: string, now: number) {
  const firstDay = earliestDay(env, now);
  const expiring = await env.DB.prepare(
    "SELECT * FROM archive_days WHERE day < ? OR status = 'deleting' ORDER BY day LIMIT 1",
  )
    .bind(firstDay)
    .first<ArchiveDay>();
  if (expiring) return expireArchive(env, expiring, token);

  const expired = await env.DB.prepare('SELECT id FROM events WHERE occurred_at < ? LIMIT 1')
    .bind(dayStart(firstDay))
    .first();
  if (expired) {
    const result = await env.DB.prepare(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE occurred_at < ? ORDER BY occurred_at, id LIMIT 1000) AND ${guard}`,
    )
      .bind(dayStart(firstDay), ...owned(token))
      .run();
    return `expired-events:${result.meta.changes}`;
  }

  const toClean = await env.DB.prepare(
    "SELECT * FROM archive_days WHERE status = 'published' ORDER BY day LIMIT 1",
  ).first<ArchiveDay>();
  if (toClean) {
    const result = await env.DB.prepare(
      `DELETE FROM events WHERE id IN
      (SELECT id FROM events WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id LIMIT 1000)
      AND ${guard}`,
    )
      .bind(dayStart(toClean.day), dayStart(toClean.day) + DAY, ...owned(token))
      .run();
    if (result.meta.changes < 1000) {
      assertChanged(
        await env.DB.prepare(
          `UPDATE archive_days SET status = 'cleaned' WHERE day = ? AND ${guard}`,
        )
          .bind(toClean.day, ...owned(token))
          .run(),
      );
    }
    return `cleaned:${toClean.day}:${result.meta.changes}`;
  }

  let active = await env.DB.prepare(
    "SELECT * FROM archive_days WHERE status = 'uploading' ORDER BY day LIMIT 1",
  ).first<ArchiveDay>();
  if (!active) {
    const next = await env.DB.prepare(
      'SELECT occurred_at FROM events WHERE occurred_at < ? ORDER BY occurred_at, id LIMIT 1',
    )
      .bind(hotCutoff(now))
      .first<{ occurred_at: number }>();
    if (!next) {
      await env.DB.prepare(
        `DELETE FROM links WHERE id IN (SELECT id FROM links WHERE deleted_at < ? LIMIT 100) AND ${guard}`,
      )
        .bind(dayStart(firstDay) - DAY, ...owned(token))
        .run();
      return 'idle';
    }
    const day = dayOf(next.occurred_at);
    assertChanged(
      await env.DB.prepare(`INSERT INTO archive_days(day, created_at) SELECT ?, ? WHERE ${guard}`)
        .bind(day, now, ...owned(token))
        .run(),
    );
    active = (await env.DB.prepare('SELECT * FROM archive_days WHERE day = ?')
      .bind(day)
      .first<ArchiveDay>())!;
  }
  return uploadStep(env, active, token, now);
}

export async function runMaintenance(env: Env, now = Date.now()) {
  config(env);
  const token = crypto.randomUUID();
  const wall = Date.now();
  const lease = await env.DB.prepare(
    'UPDATE maintenance SET token = ?, locked_until = ?, last_run_at = ? WHERE id = 1 AND locked_until <= ? RETURNING id',
  )
    .bind(token, wall + 120_000, now, wall)
    .first();
  if (!lease) return 'locked';
  try {
    const action = await step(env, token, now);
    await env.DB.prepare(
      'UPDATE maintenance SET token = NULL, locked_until = 0, last_success_at = ?, last_action = ?, last_error = NULL WHERE id = 1 AND token = ?',
    )
      .bind(now, action, token)
      .run();
    return action;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : 'Archive maintenance failed';
    await env.DB.prepare(
      'UPDATE maintenance SET token = NULL, locked_until = 0, last_error = ? WHERE id = 1 AND token = ?',
    )
      .bind(message, token)
      .run();
    throw error;
  }
}

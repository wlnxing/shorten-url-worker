import type { Mode } from '../shared/types';

export type Env = Cloudflare.Env;
export type AppEnv = { Bindings: Env };
export const DAY = 86_400_000;
export const HOT_DAYS = 14;
export const CACHE_SECONDS = 60;
export function config(env: Env) {
  const mode = env.MODE ?? 'economy';
  const retentionDays = Number(env.STATS_RETENTION_DAYS ?? 180);
  const archiveBatchSize = Number(env.ARCHIVE_BATCH_SIZE ?? 500);
  const archiveMaxKb = Number(env.ARCHIVE_MAX_KB ?? 512);
  if (mode !== 'economy' && mode !== 'detailed')
    throw new Error('MODE must be economy or detailed');
  if (!Number.isInteger(retentionDays) || retentionDays < 15 || retentionDays > 36500)
    throw new Error('STATS_RETENTION_DAYS must be 15..36500');
  if (!Number.isInteger(archiveBatchSize) || archiveBatchSize < 1 || archiveBatchSize > 500)
    throw new Error('ARCHIVE_BATCH_SIZE must be 1..500');
  if (!Number.isInteger(archiveMaxKb) || archiveMaxKb < 16 || archiveMaxKb > 16384)
    throw new Error('ARCHIVE_MAX_KB must be 16..16384 (1 KB = 1024 bytes)');
  return { mode: mode as Mode, retentionDays, archiveBatchSize, archiveMaxKb };
}
export function dayOf(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
export function dayStart(day: string) {
  return Date.parse(`${day}T00:00:00.000Z`);
}
export function earliestDay(env: Env, now = Date.now()) {
  // Retention is a count of UTC calendar dates, including today.
  return dayOf(dayStart(dayOf(now)) - (config(env).retentionDays - 1) * DAY);
}
export function hotCutoff(now = Date.now()) {
  return dayStart(dayOf(now)) - HOT_DAYS * DAY;
}
export const published = "('published', 'cleaned')";

export type Mode = 'economy' | 'detailed';
export interface Link {
  id: string;
  slug: string;
  target: string;
  title: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}
export interface Visit {
  id: number;
  link_id: string;
  slug: string;
  occurred_at: number;
  ip: string;
  country: string;
  region: string;
  city: string;
  referer: string;
  ua: string;
  browser: string;
  device: string;
  visitor_key: string | null;
}
export interface DailyStat {
  day: string;
  pv: number;
  uv: number;
}
export interface Breakdown {
  name: string;
  count: number;
}
export interface Stats {
  daily: DailyStat[];
  countries: Breakdown[];
  referers: Breakdown[];
  browsers: Breakdown[];
  devices: Breakdown[];
}
export interface ArchiveDay {
  day: string;
  status: 'uploading' | 'published' | 'cleaned' | 'deleting';
  cursor_time: number;
  cursor_id: number;
  part_count: number;
  row_count: number;
  byte_count: number;
  published_at: number | null;
  created_at: number;
}
export interface ArchivePart {
  id: string;
  day: string;
  part: number;
  status: 'pending' | 'ready';
  first_time: number;
  first_id: number;
  last_time: number;
  last_id: number;
  row_count: number;
  byte_count: number;
  sha256: string;
}
export interface StatsResponse extends Stats {
  archives: ArchiveDay[];
  from: string;
  to: string;
}
export interface SystemStatus {
  mode: Mode;
  retentionDays: number;
  hotDays: number;
  archiveBatchSize: number;
  archiveMaxKb: number;
  earliestDay: string;
  today: string;
  maintenance: {
    last_run_at: number | null;
    last_success_at: number | null;
    last_action: string | null;
    last_error: string | null;
  };
  backlog: number;
}

<script setup lang="ts">
import { cloneVNode, computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { VNode } from 'vue';
import Alert from 'ant-design-vue/es/alert';
import Button from 'ant-design-vue/es/button';
import ConfigProvider from 'ant-design-vue/es/config-provider';
import Input from 'ant-design-vue/es/input';
import Modal from 'ant-design-vue/es/modal';
import Pagination from 'ant-design-vue/es/pagination';
import Skeleton from 'ant-design-vue/es/skeleton';
import Spin from 'ant-design-vue/es/spin';
import Switch from 'ant-design-vue/es/switch';
import Tag from 'ant-design-vue/es/tag';
import Tooltip from 'ant-design-vue/es/tooltip';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  BarChartOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloudOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FileZipOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  LinkOutlined,
  LockOutlined,
  LogoutOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons-vue';

import { uiTheme } from './theme';
import type {
  ArchiveDay,
  Breakdown,
  Link,
  Stats,
  StatsResponse,
  SystemStatus,
  Visit,
} from '../shared/types';
import { api, ApiError } from './api';

const ready = ref(false),
  loggedIn = ref(false),
  password = ref(''),
  loginBusy = ref(false);
const error = ref(''),
  notice = ref('');
const tab = ref<'links' | 'stats' | 'archives'>('links');
const system = ref<SystemStatus | null>(null);
const list = ref<Link[]>([]),
  total = ref(0),
  page = ref(1),
  query = ref(''),
  linksBusy = ref(false);
const mutating = ref(false);
const editorOpen = ref(false),
  deleteOpen = ref(false);
const deleteError = ref('');
const targetInput = ref<{ focus: () => void }>();
const appliedSearch = ref('');
const copiedId = ref('');
const PasswordInput = Input.Password;
const SearchInput = Input.Search;
const editingId = ref(''),
  deleting = ref<Link | null>(null);
const form = ref({ slug: '', target: '', title: '', enabled: true });
const formError = ref('');
const today = new Date().toISOString().slice(0, 10);
const from = ref(new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)),
  to = ref(today),
  linkId = ref('');
const choices = ref<Link[]>([]),
  statsBusy = ref(false),
  progress = ref(0),
  archiveLoading = ref(false),
  partial = ref(false);
const statsResult = ref<Stats | null>(null),
  coldDays = ref<ArchiveDay[]>([]);
const appliedQuery = ref({ from: from.value, to: to.value, linkId: '' });
const detailDay = ref(today),
  events = ref<Visit[]>([]),
  detailBusy = ref(false),
  eventPage = ref(1),
  hasMore = ref(false);
const cursors = ref<(string | null)[]>([null]);
const visitOpen = ref(false),
  selectedVisit = ref<Visit | null>(null);
const archiveRows = ref<ArchiveDay[]>([]),
  archivePage = ref(1),
  archivesBusy = ref(false);
const jobs = new Map<string, { worker: Worker; reject: (error: Error) => void }>();
let toastTimer: ReturnType<typeof setTimeout>;
let copyTimer: ReturnType<typeof setTimeout>;
let statsRequest = 0,
  detailRequest = 0,
  linksRequest = 0;

const number = (value: number) =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
const shortUrl = (slug: string) => `${window.location.origin}/s/${slug}`;
const modeName = computed(() => (system.value?.mode === 'detailed' ? '详细模式' : '经济模式'));
const pageTitle = computed(
  () => ({ links: '短链管理', stats: '访问统计', archives: '历史归档' })[tab.value],
);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 20)));
const host = window.location.host;
const pv = computed(() => statsResult.value?.daily.reduce((sum, d) => sum + d.pv, 0) ?? 0);
const chartDays = computed(() => {
  if (!statsResult.value) return [];
  const days = [];
  const lookup = new Map(statsResult.value.daily.map((day) => [day.day, day]));
  for (
    let at = Date.parse(appliedQuery.value.from);
    at <= Date.parse(appliedQuery.value.to) && days.length < 366;
    at += 86400000
  ) {
    const day = new Date(at).toISOString().slice(0, 10);
    days.push(lookup.get(day) ?? { day, pv: 0, uv: 0 });
  }
  return days;
});
const averageUv = computed(() =>
  chartDays.value.length
    ? chartDays.value.reduce((sum, d) => sum + d.uv, 0) / chartDays.value.length
    : 0,
);
const maxPv = computed(() => Math.max(1, ...chartDays.value.map((day) => day.pv)));
const breakdowns = computed(() =>
  statsResult.value
    ? [
        { label: '国家 / 地区', values: statsResult.value.countries, empty: '未知地区' },
        { label: '来源网站', values: statsResult.value.referers, empty: '直接访问' },
        { label: '浏览器', values: statsResult.value.browsers, empty: '未知浏览器' },
        { label: '设备', values: statsResult.value.devices, empty: '未知设备' },
      ]
    : [],
);
const visitFields = computed(() => {
  const visit = selectedVisit.value;
  if (!visit) return [];
  return [
    { label: '短链路径', value: `/s/${visit.slug}`, mono: true, wide: true },
    { label: '访问域名', value: visit.hostname, mono: true, wide: true },
    { label: '额外查询参数（Query）', value: visit.query || '无', mono: true, wide: true },
    { label: '访问时间（本地）', value: time(visit.occurred_at) },
    { label: '时间戳（毫秒）', value: String(visit.occurred_at), mono: true },
    { label: 'User-Agent（UA）', value: visit.ua || '未记录', mono: true, wide: true },
    { label: '浏览器', value: visit.browser || '未知' },
    { label: '设备类型', value: visit.device || '未知' },
    { label: 'IP 地址', value: visit.ip || '未知', mono: true },
    { label: '来源域名', value: visit.referer || '直接访问 / 未提供', mono: true },
    { label: '国家 / 地区', value: visit.country || '未知' },
    { label: '省 / 州', value: visit.region || '未知' },
    { label: '城市', value: visit.city || '未知' },
    { label: '记录 ID', value: String(visit.id), mono: true },
    { label: '短链 ID', value: visit.link_id, mono: true, wide: true },
    {
      label: '访客标识（UV 去重）',
      value: visit.visitor_key || '未生成',
      mono: true,
      wide: true,
    },
  ];
});

function report(e: unknown) {
  error.value = e instanceof Error ? e.message : '操作失败，请重试';
}
function toast(message: string) {
  notice.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (notice.value = ''), 4500);
}
function cancelJob(name: string) {
  const job = jobs.get(name);
  if (job) {
    job.worker.terminate();
    job.reject(new Error('已取消加载'));
    jobs.delete(name);
  }
}
function archiveJob<T>(name: string, data: unknown): Promise<T> {
  cancelJob(name);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./archive-worker.ts', import.meta.url), { type: 'module' });
    jobs.set(name, { worker, reject });
    worker.onmessage = (event) => {
      if (event.data.type === 'progress' && name === 'stats') progress.value = event.data.value;
      if (event.data.type === 'done' || event.data.type === 'error') {
        worker.terminate();
        jobs.delete(name);
        if (event.data.type === 'done') resolve(event.data.result as T);
        else reject(new Error(event.data.message));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      jobs.delete(name);
      reject(new Error('归档解析失败，请使用支持 gzip 解压的现代浏览器'));
    };
    worker.postMessage(data);
  });
}
function endSession() {
  linksRequest++;
  statsRequest++;
  detailRequest++;
  for (const name of [...jobs.keys()]) cancelJob(name);
  loggedIn.value = false;
  statsResult.value = null;
  events.value = [];
  visitOpen.value = false;
  selectedVisit.value = null;
  list.value = [];
  choices.value = [];
  archiveRows.value = [];
  editorOpen.value = false;
  deleteOpen.value = false;
  tab.value = 'links';
  query.value = '';
  appliedSearch.value = '';
  page.value = 1;
  total.value = 0;
  system.value = null;
}
async function bootstrap() {
  await api('/auth/session');
  loggedIn.value = true;
  system.value = await api<SystemStatus>('/admin/status');
  await loadLinks();
}
async function login() {
  error.value = '';
  loginBusy.value = true;
  try {
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    });
    password.value = '';
    await bootstrap();
  } catch (e) {
    report(e);
  } finally {
    loginBusy.value = false;
  }
}
async function logout() {
  try {
    await api('/auth/logout', { method: 'POST', body: '{}' });
    endSession();
  } catch (e) {
    report(e);
  }
}
async function loadLinks(reset = false) {
  if (reset) page.value = 1;
  const request = ++linksRequest;
  const search = query.value.trim();
  linksBusy.value = true;
  try {
    const data = await api<{ items: Link[]; total: number }>(
      `/admin/links?page=${page.value}&q=${encodeURIComponent(search)}`,
    );
    if (request !== linksRequest) return;
    list.value = data.items;
    total.value = data.total;
    appliedSearch.value = search;
  } catch (e) {
    if (request === linksRequest) report(e);
  } finally {
    if (request === linksRequest) linksBusy.value = false;
  }
}
async function navigate(next: typeof tab.value) {
  error.value = '';
  visitOpen.value = false;
  if (next !== 'stats') {
    statsRequest++;
    detailRequest++;
    cancelJob('stats');
    cancelJob('events');
    statsBusy.value = false;
    archiveLoading.value = false;
    detailBusy.value = false;
  }
  tab.value = next;
  document.title = `shorten url · ${pageTitle.value}`;
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (next === 'links') await loadLinks();
  if (next === 'stats') {
    try {
      choices.value = (
        await api<{ items: Link[] }>('/admin/links?size=100&includeDeleted=true')
      ).items;
    } catch (e) {
      report(e);
    }
    await loadStats();
  }
  if (next === 'archives') await loadArchives();
}
async function openEditor(link?: Link) {
  formError.value = '';
  editingId.value = link?.id ?? '';
  form.value = link
    ? { slug: link.slug, target: link.target, title: link.title, enabled: Boolean(link.enabled) }
    : { slug: '', target: '', title: '', enabled: true };
  editorOpen.value = true;
  await nextTick();
  targetInput.value?.focus();
}
async function save() {
  mutating.value = true;
  formError.value = '';
  try {
    await api(`/admin/links${editingId.value ? `/${editingId.value}` : ''}`, {
      method: editingId.value ? 'PUT' : 'POST',
      body: JSON.stringify(form.value),
    });
    editorOpen.value = false;
    toast(editingId.value ? '已保存，最多 60 秒内生效' : '短链已创建');
    await loadLinks(true);
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    mutating.value = false;
  }
}
async function toggle(link: Link) {
  mutating.value = true;
  try {
    await api(`/admin/links/${link.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...link, enabled: !link.enabled }),
    });
    toast('状态已更新，最多 60 秒内生效');
    await loadLinks();
  } catch (e) {
    report(e);
  } finally {
    mutating.value = false;
  }
}
async function remove() {
  if (!deleting.value) return;
  mutating.value = true;
  deleteError.value = '';
  try {
    await api(`/admin/links/${deleting.value.id}`, { method: 'DELETE', body: '{}' });
    deleteOpen.value = false;
    toast('短链已删除，历史统计继续保留');
    await loadLinks(true);
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : '删除失败，请重试';
  } finally {
    mutating.value = false;
  }
}
async function copy(link: Link) {
  try {
    await navigator.clipboard.writeText(shortUrl(link.slug));
    copiedId.value = link.id;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copiedId.value = ''), 2500);
    toast('短链已复制');
  } catch {
    error.value = '复制失败，请手动复制短链';
  }
}
function confirmDelete(link: Link) {
  deleting.value = link;
  deleteError.value = '';
  deleteOpen.value = true;
}
function changePage(value: number) {
  page.value = value;
  void loadLinks();
}
function paginationItem({
  page,
  type,
  originalElement,
}: {
  page: number;
  type: string;
  originalElement: VNode;
}) {
  return cloneVNode(originalElement, {
    'aria-label': type === 'prev' ? '上一页' : type === 'next' ? '下一页' : `第 ${page} 页`,
  });
}
function clearSearch() {
  query.value = '';
  void loadLinks(true);
}
function mergeBreakdown(a: Breakdown[], b: Breakdown[]) {
  const map = new Map(a.map((item) => [item.name, item.count]));
  for (const item of b) map.set(item.name, (map.get(item.name) ?? 0) + item.count);
  return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}
async function loadStats() {
  const request = ++statsRequest;
  const query = { from: from.value, to: to.value, linkId: linkId.value };
  cancelJob('stats');
  statsBusy.value = true;
  archiveLoading.value = false;
  partial.value = false;
  progress.value = 0;
  error.value = '';
  try {
    const response = await api<StatsResponse>(
      `/admin/stats?from=${query.from}&to=${query.to}&linkId=${encodeURIComponent(query.linkId)}`,
    );
    if (request !== statsRequest) return;
    statsResult.value = response;
    coldDays.value = response.archives;
    appliedQuery.value = { from: response.from, to: response.to, linkId: query.linkId };
    from.value = response.from;
    if (detailDay.value < from.value || detailDay.value > to.value) detailDay.value = to.value;
    void loadEvents(true);
    if (response.archives.length) {
      archiveLoading.value = true;
      partial.value = true;
      const historical = await archiveJob<Stats>('stats', {
        kind: 'stats',
        days: response.archives,
        linkId: query.linkId,
      });
      if (request !== statsRequest) return;
      statsResult.value = {
        daily: [...response.daily, ...historical.daily].sort((a, b) => a.day.localeCompare(b.day)),
        countries: mergeBreakdown(response.countries, historical.countries),
        referers: mergeBreakdown(response.referers, historical.referers),
        browsers: mergeBreakdown(response.browsers, historical.browsers),
        devices: mergeBreakdown(response.devices, historical.devices),
      };
      partial.value = false;
    }
  } catch (e) {
    if (request === statsRequest) report(e);
  } finally {
    if (request === statsRequest) {
      statsBusy.value = false;
      archiveLoading.value = false;
    }
  }
}
async function loadEvents(reset = false) {
  const request = ++detailRequest;
  visitOpen.value = false;
  cancelJob('events');
  detailBusy.value = true;
  if (reset) {
    eventPage.value = 1;
    cursors.value = [null];
  }
  try {
    let archived = coldDays.value.some((day) => day.day === detailDay.value);
    if (!archived) {
      try {
        const cursor = cursors.value[eventPage.value - 1];
        const data = await api<{ items: Visit[]; nextCursor: string | null }>(
          `/admin/stats/events?day=${detailDay.value}&linkId=${encodeURIComponent(appliedQuery.value.linkId)}${cursor ? `&cursor=${cursor}` : ''}`,
        );
        if (request !== detailRequest) return;
        events.value = data.items;
        hasMore.value = Boolean(data.nextCursor);
        cursors.value[eventPage.value] = data.nextCursor;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) archived = true;
        else throw e;
      }
    }
    if (archived) {
      const data = await archiveJob<{ items: Visit[]; hasMore: boolean }>('events', {
        kind: 'events',
        day: detailDay.value,
        linkId: appliedQuery.value.linkId,
        page: eventPage.value,
      });
      if (request !== detailRequest) return;
      events.value = data.items;
      hasMore.value = data.hasMore;
    }
  } catch (e) {
    if (request === detailRequest) {
      events.value = [];
      report(e);
    }
  } finally {
    if (request === detailRequest) detailBusy.value = false;
  }
}
async function loadArchives() {
  archivesBusy.value = true;
  try {
    const [status, rows] = await Promise.all([
      api<SystemStatus>('/admin/status'),
      api<{ items: ArchiveDay[] }>(`/admin/archives?page=${archivePage.value}`),
    ]);
    system.value = status;
    archiveRows.value = rows.items;
  } catch (e) {
    report(e);
  } finally {
    archivesBusy.value = false;
  }
}
function archiveLabel(status: ArchiveDay['status']) {
  return {
    uploading: '正在归档',
    published: '已发布 · 清理中',
    cleaned: '已归档',
    deleting: '到期清理中',
  }[status];
}
onMounted(async () => {
  window.addEventListener('session-expired', endSession);
  try {
    await bootstrap();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) report(e);
  } finally {
    ready.value = true;
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('session-expired', endSession);
  clearTimeout(toastTimer);
  clearTimeout(copyTimer);
  for (const name of [...jobs.keys()]) cancelJob(name);
});
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="uiTheme" :auto-insert-space-in-button="false">
    <div v-if="!ready" class="boot" role="status">
      <div class="brand-mark"><LinkOutlined aria-hidden="true" /></div>
      <Spin /><span>正在打开工作台…</span>
    </div>
    <main v-else-if="!loggedIn" class="login-layout">
      <section class="login-story">
        <a href="/admin/" class="brand brand-light">
          <span class="brand-mark"><LinkOutlined aria-hidden="true" /></span>
          <span>shorten<span class="brand-word">url</span><small>你的短链工作台</small></span>
        </a>
        <div class="login-story-content">
          <span class="story-label"><span></span> SMALL LINKS. BIG POSSIBILITIES.</span>
          <h1>更短的链接，<br />更清晰的连接<span>。</span></h1>
          <p>让每一个网址变得简洁好记。<br />从创建、分享，到了解每一次访问。</p>
          <div class="connection-art" aria-hidden="true">
            <div class="url-card original-url">
              <GlobalOutlined aria-hidden="true" />
              <div>
                <small>从一个长网址开始</small><span>https://example.com/your-next-big-idea</span>
              </div>
            </div>
            <div class="connection-line">
              <span></span><ArrowRightOutlined aria-hidden="true" /><span></span
              ><small>简单一点，刚刚好</small>
            </div>
            <div class="url-card shortened-url">
              <div class="art-link-icon"><LinkOutlined aria-hidden="true" /></div>
              <div>
                <small>一个好记的新入口</small><strong>your.link<span>/s/hello</span></strong>
              </div>
              <ExportOutlined aria-hidden="true" />
            </div>
          </div>
          <div class="story-features">
            <span><CheckOutlined aria-hidden="true" /> 自定义路径</span
            ><span><CheckOutlined aria-hidden="true" /> 访问洞察</span
            ><span><CheckOutlined aria-hidden="true" /> 历史归档</span>
          </div>
        </div>
        <span class="story-footer">更少的字符，更多的可能。</span>
      </section>
      <section class="login-panel">
        <div class="login-panel-caption">
          <SafetyCertificateOutlined aria-hidden="true" /> 私人工作空间
        </div>
        <form class="login-form" @submit.prevent="login">
          <div class="login-symbol"><ArrowRightOutlined aria-hidden="true" /></div>
          <span class="eyebrow">WELCOME BACK</span>
          <h2>欢迎回来</h2>
          <p class="login-description">登录工作台，管理你的每一个连接。</p>
          <label for="password">管理员密码</label>
          <PasswordInput
            id="password"
            v-model:value="password"
            size="large"
            autocomplete="current-password"
            required
            autofocus
            placeholder="请输入管理员密码"
            :disabled="loginBusy"
            :status="error ? 'error' : undefined"
            :aria-invalid="!!error"
            :aria-describedby="error ? 'login-error' : undefined"
          >
            <template #prefix><LockOutlined aria-hidden="true" class="input-icon" /></template>
          </PasswordInput>
          <Alert
            v-if="error"
            id="login-error"
            class="form-alert"
            :message="error"
            type="error"
            show-icon
            role="alert"
          />
          <Button
            class="login-submit"
            type="primary"
            size="large"
            block
            html-type="submit"
            :loading="loginBusy"
            >{{ loginBusy ? '正在登录' : '进入工作台'
            }}<ArrowRightOutlined aria-hidden="true" v-if="!loginBusy"
          /></Button>
          <p class="login-note">
            <LockOutlined aria-hidden="true" /> 仅限管理员访问，安全管理你的链接
          </p>
        </form>
        <p class="login-footer">shorten url <span>·</span> 让连接保持简单</p>
      </section>
    </main>
    <div v-else class="workspace">
      <a class="skip-link" href="#main-content">跳转到主内容</a>
      <aside class="sidebar">
        <a href="/admin/" class="brand"
          ><span class="brand-mark"><LinkOutlined aria-hidden="true" /></span
          ><span>shorten<span class="brand-word">url</span><small>你的短链工作台</small></span></a
        >
        <div class="workspace-label">
          <span class="workspace-icon"><AppstoreOutlined aria-hidden="true" /></span>
          <div><strong>个人工作空间</strong><small>链接管理控制台</small></div>
        </div>
        <span class="nav-label">工作台</span>
        <nav aria-label="主导航">
          <button
            :class="{ active: tab === 'links' }"
            :aria-current="tab === 'links' ? 'page' : undefined"
            @click="navigate('links')"
          >
            <LinkOutlined aria-hidden="true" /><span>短链管理</span
            ><RightOutlined aria-hidden="true" class="nav-arrow" />
          </button>
          <button
            :class="{ active: tab === 'stats' }"
            :aria-current="tab === 'stats' ? 'page' : undefined"
            @click="navigate('stats')"
          >
            <BarChartOutlined aria-hidden="true" /><span>访问统计</span
            ><RightOutlined aria-hidden="true" class="nav-arrow" />
          </button>
          <button
            :class="{ active: tab === 'archives' }"
            :aria-current="tab === 'archives' ? 'page' : undefined"
            @click="navigate('archives')"
          >
            <FileZipOutlined aria-hidden="true" /><span>历史归档</span
            ><RightOutlined aria-hidden="true" class="nav-arrow" />
          </button>
        </nav>
        <div class="sidebar-bottom">
          <div class="mode-card">
            <span class="mode-icon"><ThunderboltOutlined aria-hidden="true" /></span
            ><strong>{{ modeName }}</strong
            ><span class="status-dot"></span>
            <p>
              {{
                system?.mode === 'economy'
                  ? '轻量运行，专注每一次跳转'
                  : '记录每一次访问，发现更多洞察'
              }}
            </p>
          </div>
          <div class="sidebar-account">
            <span class="admin-avatar"><UserOutlined aria-hidden="true" /></span>
            <div><strong>管理员</strong><small>工作空间所有者</small></div>
            <Tooltip title="退出登录"
              ><Button type="text" aria-label="退出登录" @click="logout"
                ><LogoutOutlined aria-hidden="true" /></Button
            ></Tooltip>
          </div>
        </div>
      </aside>
      <div class="main-content">
        <header class="topbar">
          <div class="breadcrumb">
            <AppstoreOutlined aria-hidden="true" /><span class="breadcrumb-parent">工作空间</span
            ><RightOutlined aria-hidden="true" class="crumb" /><span>{{ pageTitle }}</span>
          </div>
          <div class="topbar-right">
            <span class="host-label"><GlobalOutlined aria-hidden="true" />{{ host }}</span
            ><span class="topbar-divider"></span
            ><span class="workspace-status"><span class="status-dot"></span>工作空间</span
            ><Button class="mobile-logout" type="text" aria-label="退出登录" @click="logout"
              ><LogoutOutlined aria-hidden="true"
            /></Button>
          </div>
        </header>
        <main id="main-content" class="content" tabindex="-1">
          <Alert
            v-if="error"
            class="global-error"
            :message="error"
            type="error"
            show-icon
            closable
            role="alert"
            @close="error = ''"
          />
          <template v-if="tab === 'links'">
            <div class="page-heading">
              <div>
                <span class="eyebrow">YOUR LINKS</span>
                <h1>短链管理</h1>
                <p>把长网址变成好记的短链，让每一次分享更简单。</p>
              </div>
              <Button type="primary" @click="openEditor()"
                ><template #icon><PlusOutlined aria-hidden="true" /></template>新建短链</Button
              >
            </div>
            <div class="overview-grid">
              <section class="metric">
                <div class="metric-header">
                  <span>{{ appliedSearch ? '匹配短链' : '短链总数' }}</span
                  ><span class="metric-icon"><LinkOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value">{{ number(total) }}<small>个</small></strong>
                <p>
                  <span class="metric-dot"></span
                  >{{ appliedSearch ? '当前搜索条件下的结果' : '所有连接，在这里井然有序' }}
                </p>
              </section>
              <section class="metric">
                <div class="metric-header">
                  <span>当前运行模式</span
                  ><span class="metric-icon green"><ThunderboltOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value text-metric"
                  >{{ modeName }}<Tag color="success" :bordered="false">运行中</Tag></strong
                >
                <p>
                  {{
                    system?.mode === 'economy'
                      ? '暂停记录新访问，已有统计仍可查询'
                      : '自动记录访问趋势与访客明细'
                  }}
                </p>
              </section>
              <section class="metric tip-card">
                <div class="metric-header">
                  <span>好链接，也有好名字</span><ExportOutlined aria-hidden="true" />
                </div>
                <strong class="example-url">/s/your-next-idea</strong>
                <p>自定义路径，让分享多一点辨识度。</p>
                <button class="text-link" @click="openEditor()">
                  创建专属短链 <ArrowRightOutlined aria-hidden="true" />
                </button>
              </section>
            </div>
            <section class="panel links-panel" aria-labelledby="links-title" :aria-busy="linksBusy">
              <div class="panel-toolbar">
                <div class="panel-title">
                  <h2 id="links-title">{{ appliedSearch ? '搜索结果' : '全部短链' }}</h2>
                  <span class="count">{{ number(total) }}</span>
                </div>
                <div class="toolbar-actions">
                  <SearchInput
                    v-model:value="query"
                    class="search-input"
                    placeholder="搜索路径、标题或目标网址"
                    aria-label="搜索短链"
                    allow-clear
                    :loading="linksBusy"
                    @search="loadLinks(true)"
                  >
                    <template #enterButton>
                      <Button aria-label="搜索短链" :loading="linksBusy"
                        ><SearchOutlined aria-hidden="true" v-if="!linksBusy"
                      /></Button>
                    </template> </SearchInput
                  ><Tooltip title="刷新列表"
                    ><Button
                      class="refresh-button"
                      aria-label="刷新列表"
                      :loading="linksBusy"
                      @click="loadLinks()"
                      ><ReloadOutlined aria-hidden="true" v-if="!linksBusy" /></Button
                  ></Tooltip>
                </div>
              </div>
              <div v-if="appliedSearch" class="search-summary">
                <span>包含「{{ appliedSearch }}」的短链</span
                ><Button type="link" size="small" @click="clearSearch">清除搜索</Button>
              </div>
              <div
                v-if="linksBusy && !list.length"
                class="loading-state"
                role="status"
                aria-label="正在加载短链"
              >
                <Skeleton active :paragraph="{ rows: 4 }" />
              </div>
              <template v-else>
                <div v-if="list.length" class="table-scroll">
                  <table class="links-table">
                    <caption class="sr-only">
                      短链列表，包含目标网址、启用状态、创建日期和管理操作
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">短链 / 目标网址</th>
                        <th scope="col">状态</th>
                        <th scope="col">创建日期</th>
                        <th scope="col" class="align-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="link in list" :key="link.id">
                        <td class="link-cell">
                          <div class="link-item">
                            <div class="link-symbol"><LinkOutlined aria-hidden="true" /></div>
                            <div class="link-information">
                              <div class="link-title">
                                <a
                                  :href="shortUrl(link.slug)"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  :title="shortUrl(link.slug)"
                                  >/s/{{ link.slug }}<ExportOutlined aria-hidden="true" /></a
                                ><span v-if="link.title" class="link-note">{{ link.title }}</span>
                              </div>
                              <div class="target-url" :title="link.target">{{ link.target }}</div>
                            </div>
                          </div>
                        </td>
                        <td data-label="状态">
                          <div class="link-state">
                            <Switch
                              :checked="Boolean(link.enabled)"
                              size="small"
                              :disabled="mutating"
                              :aria-label="`${link.enabled ? '停用' : '启用'}短链 /s/${link.slug}`"
                              @change="toggle(link)"
                            /><span :class="{ muted: !link.enabled }">{{
                              link.enabled ? '启用中' : '已停用'
                            }}</span>
                          </div>
                        </td>
                        <td data-label="创建日期" class="date-cell">
                          {{ new Date(link.created_at).toLocaleDateString('zh-CN') }}
                        </td>
                        <td class="actions-cell">
                          <div class="row-actions">
                            <Tooltip :title="copiedId === link.id ? '已复制' : '复制短链'"
                              ><Button
                                type="text"
                                size="small"
                                :class="{ 'copy-success': copiedId === link.id }"
                                :aria-label="`复制短链 /s/${link.slug}`"
                                @click="copy(link)"
                                ><CheckOutlined
                                  aria-hidden="true"
                                  v-if="copiedId === link.id"
                                /><CopyOutlined aria-hidden="true" v-else /><span
                                  class="action-label"
                                  >{{ copiedId === link.id ? '已复制' : '复制' }}</span
                                ></Button
                              ></Tooltip
                            ><Tooltip title="编辑短链"
                              ><Button
                                type="text"
                                size="small"
                                :aria-label="`编辑短链 /s/${link.slug}`"
                                @click="openEditor(link)"
                                ><EditOutlined aria-hidden="true" /><span class="action-label"
                                  >编辑</span
                                ></Button
                              ></Tooltip
                            ><Tooltip title="查看统计"
                              ><Button
                                type="text"
                                size="small"
                                :aria-label="`查看 /s/${link.slug} 的统计`"
                                @click="
                                  linkId = link.id;
                                  navigate('stats');
                                "
                                ><BarChartOutlined aria-hidden="true" /><span class="action-label"
                                  >统计</span
                                ></Button
                              ></Tooltip
                            ><span class="action-divider"></span
                            ><Tooltip title="删除短链"
                              ><Button
                                type="text"
                                size="small"
                                danger
                                :aria-label="`删除短链 /s/${link.slug}`"
                                @click="confirmDelete(link)"
                                ><DeleteOutlined aria-hidden="true" /><span class="action-label"
                                  >删除</span
                                ></Button
                              ></Tooltip
                            >
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="empty-state">
                  <div class="empty-illustration">
                    <SearchOutlined aria-hidden="true" v-if="appliedSearch" /><LinkOutlined
                      aria-hidden="true"
                      v-else
                    />
                  </div>
                  <h3>{{ appliedSearch ? '没有找到匹配的短链' : '从第一个短链开始' }}</h3>
                  <p>
                    {{
                      appliedSearch
                        ? '换一个关键词，试试路径、标题或目标网址。'
                        : '粘贴一个长网址，为你的下一个分享创建简洁入口。'
                    }}
                  </p>
                  <Button v-if="appliedSearch" @click="clearSearch">查看全部短链</Button
                  ><Button v-else type="primary" @click="openEditor()"
                    ><PlusOutlined aria-hidden="true" />创建第一个短链</Button
                  >
                </div>
              </template>
              <div class="pagination">
                <span
                  >{{ linksBusy ? '正在加载…' : `共 ${number(total)} 个短链`
                  }}<span class="page-total"> · 第 {{ page }} / {{ totalPages }} 页</span></span
                ><Pagination
                  :current="page"
                  :total="total"
                  :page-size="20"
                  :show-size-changer="false"
                  :disabled="linksBusy"
                  size="small"
                  :show-less-items="true"
                  :item-render="paginationItem"
                  @change="changePage"
                />
              </div>
            </section>
            <p class="footnote">
              <InfoCircleOutlined aria-hidden="true" /> 修改、停用或删除短链后，最多需要 60 秒生效。
            </p>
          </template>

          <template v-if="tab === 'stats'">
            <div class="page-heading">
              <div>
                <span class="eyebrow">LINK ANALYTICS</span>
                <h1>访问统计</h1>
                <p>每一次点击都有迹可循，了解链接背后的访问。</p>
              </div>
              <Tag class="heading-tag" :bordered="false"
                ><ClockCircleOutlined aria-hidden="true" /> 按 UTC 日期统计</Tag
              >
            </div>
            <Alert
              v-if="system?.mode === 'economy'"
              class="global-error"
              message="当前为经济模式，暂停记录新访问；已有统计仍可查询。"
              type="info"
              show-icon
            />
            <form class="filter-bar panel" @submit.prevent="loadStats">
              <label
                >开始日期<input
                  v-model="from"
                  type="date"
                  :min="system?.earliestDay"
                  :max="to"
                  :disabled="statsBusy"
                  required /></label
              ><span class="date-separator">—</span
              ><label
                >结束日期<input
                  v-model="to"
                  type="date"
                  :min="from"
                  :max="today"
                  :disabled="statsBusy"
                  required /></label
              ><label class="grow"
                >短链<select v-model="linkId" :disabled="statsBusy">
                  <option value="">全部短链</option>
                  <option v-if="linkId && !choices.some((x) => x.id === linkId)" :value="linkId">
                    指定短链 {{ linkId }}
                  </option>
                  <option v-for="link in choices" :key="link.id" :value="link.id">
                    /s/{{ link.slug }}{{ link.deleted_at ? '（已删除）' : '' }}
                  </option>
                </select></label
              ><Button type="primary" html-type="submit" :loading="statsBusy"
                ><SearchOutlined aria-hidden="true" v-if="!statsBusy" />{{
                  statsBusy ? '正在查询' : '查询统计'
                }}</Button
              >
            </form>
            <div v-if="archiveLoading" class="progress-banner" role="status">
              <CloudOutlined aria-hidden="true" /><span>正在读取历史归档 · {{ progress }}%</span
              ><progress :value="progress" max="100" aria-label="历史归档加载进度"></progress
              ><Button type="link" size="small" @click="cancelJob('stats')">取消</Button>
            </div>
            <p v-if="partial" class="footnote">
              <InfoCircleOutlined aria-hidden="true" />历史归档尚未全部加载，当前数字为部分结果。
            </p>
            <div class="overview-grid" :aria-busy="statsBusy">
              <section class="metric">
                <div class="metric-header">
                  <span>访问次数 · PV</span
                  ><span class="metric-icon"><BarChartOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value">{{
                  statsBusy && !statsResult ? '—' : number(pv)
                }}</strong>
                <p>{{ appliedQuery.from }} 至 {{ appliedQuery.to }}</p>
              </section>
              <section class="metric">
                <div class="metric-header">
                  <span>日均独立访客 · UV</span
                  ><span class="metric-icon green"><UserOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value">{{
                  statsBusy && !statsResult ? '—' : number(averageUv)
                }}</strong>
                <p>所选范围内，每天的平均独立访客数</p>
              </section>
              <section class="metric">
                <div class="metric-header">
                  <span>包含历史归档</span
                  ><span class="metric-icon amber"><FileZipOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value">{{ coldDays.length }}<small>天</small></strong>
                <p>归档数据与近期访问合并展示</p>
              </section>
            </div>
            <section class="panel chart-panel">
              <div class="panel-toolbar">
                <div>
                  <h2>访问趋势</h2>
                  <p class="panel-description">查看所选时间范围内的每日访问量</p>
                </div>
                <span class="chart-legend"><i></i>访问次数 PV</span>
              </div>
              <div v-if="statsBusy && !statsResult" class="loading-state">
                <Skeleton active :paragraph="{ rows: 4 }" />
              </div>
              <div v-else class="chart-wrap">
                <div class="chart-y-labels" aria-hidden="true">
                  <span>{{ number(maxPv) }}</span
                  ><span>{{ number(Math.round(maxPv / 2)) }}</span
                  ><span>0</span>
                </div>
                <div class="chart-plot">
                  <svg
                    viewBox="0 0 760 180"
                    preserveAspectRatio="none"
                    role="img"
                    :aria-label="`${appliedQuery.from} 至 ${appliedQuery.to}，每日访问次数柱状图，共 ${pv} 次访问`"
                  >
                    <line
                      v-for="y in [20, 65, 110, 155]"
                      :key="y"
                      x1="0"
                      :y1="y"
                      x2="760"
                      :y2="y"
                      class="chart-gridline"
                    />
                    <rect
                      v-for="(day, index) in chartDays"
                      :key="day.day"
                      :x="(index * 760) / chartDays.length + (760 / chartDays.length) * 0.24"
                      :y="155 - (day.pv / maxPv) * 135"
                      :width="Math.max(1, (760 / chartDays.length) * 0.52)"
                      :height="Math.max(day.pv ? 2 : 0, (day.pv / maxPv) * 135)"
                      rx="4"
                      class="chart-bar"
                    >
                      <title>{{ day.day }} · PV {{ day.pv }} · UV {{ day.uv }}</title>
                    </rect>
                  </svg>
                  <div class="chart-labels">
                    <span>{{ appliedQuery.from }}</span
                    ><span>{{ appliedQuery.to }}</span>
                  </div>
                  <div v-if="!pv" class="chart-empty">
                    <BarChartOutlined aria-hidden="true" /><span>所选时间范围暂无已记录的访问</span>
                  </div>
                </div>
              </div>
            </section>
            <div class="breakdown-grid">
              <section v-for="group in breakdowns" :key="group.label" class="panel breakdown">
                <h2>{{ group.label }}<span>访问次数</span></h2>
                <div
                  v-for="(item, index) in group.values.slice(0, 6)"
                  :key="item.name"
                  class="breakdown-row"
                >
                  <div>
                    <span class="breakdown-name"
                      ><span class="rank">{{ index + 1 }}</span
                      >{{ item.name || group.empty }}</span
                    ><b>{{ number(item.count) }}</b>
                  </div>
                  <div class="bar-track">
                    <i
                      :style="{
                        width: `${(item.count / Math.max(1, group.values[0]?.count ?? 1)) * 100}%`,
                      }"
                    ></i>
                  </div>
                </div>
                <div v-if="!group.values.length" class="breakdown-empty">
                  <span>—</span>
                  <p>暂无访问数据</p>
                </div>
              </section>
            </div>
            <section class="panel" :aria-busy="detailBusy">
              <div class="panel-toolbar">
                <div>
                  <h2>访问明细</h2>
                  <p class="panel-description">逐条查看访问，点击详情可查看 UA 等完整记录</p>
                </div>
                <input
                  v-model="detailDay"
                  aria-label="明细日期"
                  type="date"
                  :min="system?.earliestDay"
                  :max="today"
                  :disabled="detailBusy"
                  @change="loadEvents(true)"
                />
              </div>
              <div class="table-scroll">
                <table class="detail-table">
                  <caption class="sr-only">
                    访问记录明细
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">访问时间</th>
                      <th scope="col">短链</th>
                      <th scope="col">访问域名</th>
                      <th scope="col">IP / 地区</th>
                      <th scope="col">来源</th>
                      <th scope="col">浏览器 / 设备</th>
                      <th scope="col" class="align-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="event in events" :key="event.id">
                      <td class="nowrap">{{ time(event.occurred_at) }}</td>
                      <td class="mono">/s/{{ event.slug }}</td>
                      <td class="event-hostname mono" :title="event.hostname">
                        {{ event.hostname }}
                      </td>
                      <td>
                        <span class="mono">{{ event.ip || '未知' }}</span
                        ><small class="cell-secondary">{{
                          [event.country, event.region, event.city].filter(Boolean).join(' · ') ||
                          '未知地区'
                        }}</small>
                      </td>
                      <td class="event-referer" :title="event.referer">
                        {{ event.referer || '直接访问' }}
                      </td>
                      <td>
                        {{ event.browser }}<small class="cell-secondary">{{ event.device }}</small>
                      </td>
                      <td class="align-right nowrap">
                        <Button
                          type="link"
                          size="small"
                          :aria-label="`查看 /s/${event.slug} 的访问详情，记录 ${event.id}`"
                          @click="
                            selectedVisit = event;
                            visitOpen = true;
                          "
                          >详情</Button
                        >
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="!events.length" class="compact-empty" role="status">
                <Spin v-if="detailBusy" /><DatabaseOutlined aria-hidden="true" v-else /><span>{{
                  detailBusy ? '正在加载明细…' : '该日暂无已记录的访问'
                }}</span>
              </div>
              <div class="pagination">
                <span>{{ detailBusy ? '正在读取…' : `第 ${eventPage} 页` }}</span>
                <div class="pagination-buttons">
                  <Button
                    size="small"
                    :disabled="eventPage <= 1 || detailBusy"
                    @click="
                      eventPage--;
                      loadEvents();
                    "
                    ><LeftOutlined aria-hidden="true" />上一页</Button
                  ><Button
                    size="small"
                    :disabled="!hasMore || detailBusy"
                    @click="
                      eventPage++;
                      loadEvents();
                    "
                    >下一页<RightOutlined aria-hidden="true"
                  /></Button>
                </div>
              </div>
            </section>
            <p class="footnote">
              <InfoCircleOutlined aria-hidden="true" /> UV 按 IP
              与浏览器信息每日去重；明细时间按你的本地时区显示。
            </p>
          </template>

          <template v-if="tab === 'archives'">
            <div class="page-heading">
              <div>
                <span class="eyebrow">YOUR LINK HISTORY</span>
                <h1>历史归档</h1>
                <p>自动整理历史访问记录，让每一次连接都有迹可循。</p>
              </div>
              <Button :loading="archivesBusy" @click="loadArchives()"
                ><ReloadOutlined aria-hidden="true" v-if="!archivesBusy" />刷新状态</Button
              >
            </div>
            <div class="overview-grid">
              <section class="metric">
                <div class="metric-header">
                  <span>自动归档间隔</span
                  ><span class="metric-icon"><ClockCircleOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value">20<small>分钟</small></strong>
                <p>自动分批处理，无需手动操作</p>
              </section>
              <section class="metric">
                <div class="metric-header">
                  <span>统计保留时间</span
                  ><span class="metric-icon green"
                    ><SafetyCertificateOutlined aria-hidden="true"
                  /></span>
                </div>
                <strong class="metric-value">{{ system?.retentionDays }}<small>天</small></strong>
                <p>保留范围包含今天，按 UTC 日期计算</p>
              </section>
              <section class="metric">
                <div class="metric-header">
                  <span>待归档访问</span
                  ><span class="metric-icon amber"><DatabaseOutlined aria-hidden="true" /></span>
                </div>
                <strong class="metric-value"
                  >{{ number(system?.backlog ?? 0) }}<small>条</small></strong
                >
                <p>归档成功后自动清理原始记录</p>
              </section>
            </div>
            <section class="panel maintenance-card">
              <div class="maintenance-icon"><CloudOutlined aria-hidden="true" /></div>
              <div>
                <strong>自动归档任务</strong>
                <p>超过 {{ system?.hotDays ?? 14 }} 天的访问记录将按日归档</p>
              </div>
              <div class="maintenance-time">
                <span>最近成功处理</span
                ><strong>{{ time(system?.maintenance.last_success_at ?? null) }}</strong>
              </div>
              <div class="maintenance-time">
                <span>最近检查</span
                ><strong>{{ time(system?.maintenance.last_run_at ?? null) }}</strong>
              </div>
              <Alert
                v-if="system?.maintenance.last_error"
                class="maintenance-error"
                :message="system.maintenance.last_error"
                type="error"
                show-icon
              />
            </section>
            <section class="panel" :aria-busy="archivesBusy">
              <div class="panel-toolbar">
                <div class="panel-title">
                  <h2>归档目录</h2>
                  <Tag :bordered="false">按日归档</Tag>
                </div>
                <span class="panel-meta">UTC 日期</span>
              </div>
              <div
                v-if="archivesBusy && !archiveRows.length"
                class="loading-state"
                role="status"
                aria-label="正在加载归档"
              >
                <Skeleton active :paragraph="{ rows: 3 }" />
              </div>
              <template v-else
                ><div v-if="archiveRows.length" class="table-scroll">
                  <table class="archive-table">
                    <caption class="sr-only">
                      历史访问归档目录
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">访问日期</th>
                        <th scope="col">归档状态</th>
                        <th scope="col">访问记录</th>
                        <th scope="col">压缩体积</th>
                        <th scope="col" class="align-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="day in archiveRows" :key="day.day">
                        <td>
                          <span class="archive-date"
                            ><FileZipOutlined aria-hidden="true" /><span class="mono">{{
                              day.day
                            }}</span></span
                          >
                        </td>
                        <td>
                          <Tag
                            :color="
                              day.status === 'cleaned'
                                ? 'success'
                                : day.status === 'published'
                                  ? 'processing'
                                  : 'warning'
                            "
                            :bordered="false"
                            >{{ archiveLabel(day.status) }}</Tag
                          >
                        </td>
                        <td>{{ number(day.row_count) }}<span class="cell-unit"> 条</span></td>
                        <td>
                          {{ (day.byte_count / 1024).toFixed(1) }}<span class="cell-unit"> KB</span>
                        </td>
                        <td class="align-right">
                          <Button
                            type="link"
                            size="small"
                            :disabled="!['published', 'cleaned'].includes(day.status)"
                            @click="
                              from = day.day;
                              to = day.day;
                              detailDay = day.day;
                              linkId = '';
                              navigate('stats');
                            "
                            >查看访问<ArrowRightOutlined aria-hidden="true"
                          /></Button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-else class="empty-state">
                  <div class="empty-illustration"><FileZipOutlined aria-hidden="true" /></div>
                  <h3>历史正在慢慢积累</h3>
                  <p>超过 {{ system?.hotDays ?? 14 }} 天的访问记录将自动出现在这里。</p>
                  <span class="empty-caption"
                    ><CheckCircleFilled aria-hidden="true" /> 自动归档已开启</span
                  >
                </div></template
              >
              <div class="pagination">
                <span>第 {{ archivePage }} 页</span>
                <div class="pagination-buttons">
                  <Button
                    size="small"
                    :disabled="archivePage <= 1 || archivesBusy"
                    @click="
                      archivePage--;
                      loadArchives();
                    "
                    ><LeftOutlined aria-hidden="true" />上一页</Button
                  ><Button
                    size="small"
                    :disabled="archiveRows.length < 50 || archivesBusy"
                    @click="
                      archivePage++;
                      loadArchives();
                    "
                    >下一页<RightOutlined aria-hidden="true"
                  /></Button>
                </div>
              </div>
            </section>
            <p class="footnote">
              <InfoCircleOutlined aria-hidden="true" /> 历史访问可在统计页与近期数据一起查询。
            </p>
          </template>
          <footer class="workspace-footer">
            <span>shorten url</span
            ><span>让连接保持简单 <ArrowUpOutlined aria-hidden="true" /></span>
          </footer>
        </main>
      </div>
      <Modal
        v-model:open="visitOpen"
        title="访问详情"
        :width="680"
        class="visit-dialog"
        @after-close="selectedVisit = null"
      >
        <dl class="visit-fields">
          <div
            v-for="field in visitFields"
            :key="field.label"
            class="visit-field"
            :class="{ 'visit-field-wide': field.wide }"
          >
            <dt>{{ field.label }}</dt>
            <dd :class="{ mono: field.mono }">{{ field.value }}</dd>
          </div>
        </dl>
        <p class="field-help">UA 展示已保存的内容，采集时最多保留 512 个字符。</p>
        <template #footer>
          <Button type="primary" @click="visitOpen = false">关闭</Button>
        </template>
      </Modal>
      <Modal
        v-model:open="editorOpen"
        :title="editingId ? '编辑短链' : '创建短链'"
        :footer="null"
        :width="520"
        :mask-closable="!mutating"
        :keyboard="!mutating"
        :closable="!mutating"
        class="edit-dialog"
      >
        <p class="dialog-description">
          {{
            editingId
              ? '更新链接信息，让每一次跳转抵达正确的目的地。'
              : '粘贴目标网址，创建一个简单、好记的新入口。'
          }}
        </p>
        <form class="editor-form" @submit.prevent="save">
          <fieldset :disabled="mutating">
            <div class="form-field">
              <label for="target">目标网址 <span class="required">*</span></label
              ><Input
                id="target"
                ref="targetInput"
                v-model:value="form.target"
                type="url"
                placeholder="https://example.com/your-destination"
                :maxlength="2048"
                required
                :disabled="mutating"
                ><template #prefix
                  ><GlobalOutlined aria-hidden="true" class="input-icon" /></template
              ></Input>
            </div>
            <div class="form-field">
              <label for="slug"
                >自定义路径<small>{{ editingId ? '必填' : '可选' }}</small></label
              ><Input
                id="slug"
                v-model:value="form.slug"
                placeholder="your-next-idea"
                :maxlength="256"
                :required="!!editingId"
                pattern="[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*"
                addon-before="/s/"
                :disabled="mutating"
                aria-describedby="slug-help"
              />
              <p id="slug-help" class="field-help">
                {{ editingId ? '' : '留空将自动生成。' }}支持字母、数字、-、_
                和多层路径，区分大小写。
              </p>
            </div>
            <div class="form-field">
              <label for="title">链接标题<small>可选</small></label
              ><Input
                id="title"
                v-model:value="form.title"
                :maxlength="120"
                placeholder="例如：产品介绍、活动报名"
                :disabled="mutating"
              />
              <p class="field-help">仅在工作台中显示，方便你识别和查找。</p>
            </div>
            <div class="link-preview">
              <span><LinkOutlined aria-hidden="true" />短链预览</span
              ><strong>{{ host }}/s/{{ form.slug || '自动生成' }}</strong>
            </div>
            <div class="enable-field">
              <div>
                <label for="link-enabled">启用短链</label>
                <p>启用后，访问短链将跳转到目标网址</p>
              </div>
              <Switch
                id="link-enabled"
                v-model:checked="form.enabled"
                :disabled="mutating"
                aria-label="启用短链"
              />
            </div>
          </fieldset>
          <Alert
            v-if="formError"
            class="form-alert"
            :message="formError"
            type="error"
            show-icon
            role="alert"
          />
          <div class="dialog-actions">
            <Button :disabled="mutating" @click="editorOpen = false">取消</Button
            ><Button type="primary" html-type="submit" :loading="mutating">{{
              editingId ? '保存修改' : '创建短链'
            }}</Button>
          </div>
        </form>
      </Modal>
      <Modal
        v-model:open="deleteOpen"
        title="删除这个短链？"
        :footer="null"
        :width="440"
        :mask-closable="!mutating"
        :keyboard="!mutating"
        :closable="!mutating"
      >
        <div class="delete-link">
          <span class="delete-icon"><DeleteOutlined aria-hidden="true" /></span>
          <div>
            <strong>/s/{{ deleting?.slug }}</strong
            ><span>{{ deleting?.title || '未设置标题' }}</span>
          </div>
        </div>
        <p class="delete-description">
          删除后，短链将在最多 60 秒内停止跳转。已有的历史访问统计会继续保留。
        </p>
        <Alert
          v-if="deleteError"
          class="form-alert"
          :message="deleteError"
          type="error"
          show-icon
          role="alert"
        />
        <div class="dialog-actions">
          <Button :disabled="mutating" @click="deleteOpen = false">取消</Button
          ><Button type="primary" danger :loading="mutating" @click="remove">确认删除</Button>
        </div>
      </Modal>
    </div>
    <Transition name="toast"
      ><div v-if="notice" class="toast-message" role="status" aria-live="polite">
        <CheckCircleFilled aria-hidden="true" />{{ notice }}
      </div></Transition
    >
  </ConfigProvider>
</template>

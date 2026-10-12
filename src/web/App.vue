<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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
const editDialog = ref<HTMLDialogElement>(),
  deleteDialog = ref<HTMLDialogElement>();
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
const archiveRows = ref<ArchiveDay[]>([]),
  archivePage = ref(1),
  archivesBusy = ref(false);
const jobs = new Map<string, { worker: Worker; reject: (error: Error) => void }>();
let toastTimer: ReturnType<typeof setTimeout>;
let statsRequest = 0,
  detailRequest = 0;

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未运行';
const shortUrl = (slug: string) => `${window.location.origin}/s/${slug}`;
const modeName = computed(() => (system.value?.mode === 'detailed' ? '详细模式' : '经济模式'));
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
  statsRequest++;
  detailRequest++;
  for (const name of [...jobs.keys()]) cancelJob(name);
  loggedIn.value = false;
  statsResult.value = null;
  events.value = [];
  list.value = [];
  choices.value = [];
  archiveRows.value = [];
  editDialog.value?.close();
  deleteDialog.value?.close();
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
  linksBusy.value = true;
  try {
    const data = await api<{ items: Link[]; total: number }>(
      `/admin/links?page=${page.value}&q=${encodeURIComponent(query.value)}`,
    );
    list.value = data.items;
    total.value = data.total;
  } catch (e) {
    report(e);
  } finally {
    linksBusy.value = false;
  }
}
async function navigate(next: typeof tab.value) {
  error.value = '';
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
  await nextTick();
  editDialog.value?.showModal();
}
async function save() {
  mutating.value = true;
  formError.value = '';
  try {
    await api(`/admin/links${editingId.value ? `/${editingId.value}` : ''}`, {
      method: editingId.value ? 'PUT' : 'POST',
      body: JSON.stringify(form.value),
    });
    editDialog.value?.close();
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
  try {
    await api(`/admin/links/${deleting.value.id}`, { method: 'DELETE', body: '{}' });
    deleteDialog.value?.close();
    toast('短链已删除，历史统计继续保留');
    await loadLinks(true);
  } catch (e) {
    report(e);
  } finally {
    mutating.value = false;
  }
}
async function copy(link: Link) {
  try {
    await navigator.clipboard.writeText(shortUrl(link.slug));
    toast('短链已复制');
  } catch {
    error.value = '复制失败，请手动复制短链';
  }
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
  for (const name of [...jobs.keys()]) cancelJob(name);
});
</script>

<template>
  <div v-if="!ready" class="boot">正在打开折径…</div>
  <main v-else-if="!loggedIn" class="login-layout">
    <section class="login-story">
      <div class="brand light">
        <span class="brand-mark">↗</span><span>折径<span class="brand-en">SHORTLINK</span></span>
      </div>
      <div>
        <span class="eyebrow">LESS DISTANCE. MORE CONNECTION.</span>
        <h1>让每一次连接，<br />更近一点。</h1>
        <p>把冗长的网址，变成清晰的入口。<br />管理你的链接，也看见链接背后的访问。</p>
      </div>
      <div class="route-art" aria-hidden="true">
        <span>https://</span><i></i><b>/s/hello</b><em>↗</em>
      </div>
      <small>轻量短链管理 · 为 Cloudflare Workers 构建</small>
    </section>
    <section class="login-panel">
      <form class="login-form" @submit.prevent="login">
        <span class="eyebrow">YOUR LINK WORKSPACE</span>
        <h2>欢迎回来</h2>
        <p class="muted">登录管理后台，继续连接每一个目的地。</p>
        <label for="password">管理员密码</label
        ><input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
          placeholder="输入管理员密码"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary full" :disabled="loginBusy">
          {{ loginBusy ? '正在登录…' : '进入工作台' }} <span>→</span>
        </button>
        <p class="login-note">私人工作台 · 仅限管理员访问</p>
      </form>
    </section>
  </main>
  <div v-else class="workspace">
    <aside class="sidebar">
      <a href="/admin/" class="brand"
        ><span class="brand-mark">↗</span
        ><span>折径<span class="brand-en">SHORTLINK</span></span></a
      >
      <span class="nav-label">工作空间</span>
      <nav aria-label="主导航">
        <button :class="{ active: tab === 'links' }" @click="navigate('links')">
          <span class="nav-icon">↗</span>短链管理<span class="nav-arrow">›</span>
        </button>
        <button :class="{ active: tab === 'stats' }" @click="navigate('stats')">
          <span class="nav-icon">▥</span>访问统计<span class="nav-arrow">›</span>
        </button>
        <button :class="{ active: tab === 'archives' }" @click="navigate('archives')">
          <span class="nav-icon">▤</span>历史归档<span class="nav-arrow">›</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="mode-card">
          <span class="status-dot"></span><strong>{{ modeName }}</strong>
          <p>
            {{ system?.mode === 'economy' ? '专注跳转，减少数据读写' : '访问明细与趋势持续记录' }}
          </p>
        </div>
        <button class="logout" @click="logout">退出登录 <span>↪</span></button
        ><small>更短的链接，更轻的负担。</small>
      </div>
    </aside>
    <main class="main-content">
      <header class="topbar">
        <span
          >工作空间 <span class="crumb">/</span>
          {{ tab === 'links' ? '短链管理' : tab === 'stats' ? '访问统计' : '历史归档' }}</span
        >
        <div class="account-menu">
          <span class="admin-avatar">A</span
          ><button class="mobile-logout" @click="logout">退出登录</button>
        </div>
      </header>
      <div class="content">
        <div v-if="error" class="error global-error" role="alert">
          {{ error }}<button aria-label="关闭提示" @click="error = ''">×</button>
        </div>
        <template v-if="tab === 'links'">
          <div class="page-heading">
            <div>
              <span class="eyebrow">LINKS, SIMPLIFIED</span>
              <h1>每个链接，都有一个好去处。</h1>
              <p>创建、整理和分享你的短链，让连接保持简单。</p>
            </div>
            <button class="primary" @click="openEditor()"><span>＋</span> 新建短链</button>
          </div>
          <div class="overview-grid">
            <section class="metric">
              <span>短链总数</span><strong>{{ number(total) }}<small>个链接</small></strong>
              <p>当前搜索范围内的短链</p>
            </section>
            <section class="metric">
              <span>当前运行模式</span
              ><strong class="text-metric"
                >{{ modeName }} <span class="tiny-badge">运行中</span></strong
              >
              <p>
                {{
                  system?.mode === 'economy'
                    ? '缓存命中时，无数据库读写'
                    : '访问记录异步保存，不等待统计写入'
                }}
              </p>
            </section>
            <section class="metric accent">
              <span>自定义，让链接更易记</span
              ><strong class="example-url">/s/your/next-idea <span>↗</span></strong>
              <p>支持多层路径，也可以自动生成短码</p>
            </section>
          </div>
          <section class="panel">
            <div class="panel-toolbar">
              <div>
                <h2>
                  我的短链 <span class="count">{{ total }}</span>
                </h2>
              </div>
              <form class="search" @submit.prevent="loadLinks(true)">
                <span aria-hidden="true">⌕</span
                ><input
                  v-model="query"
                  aria-label="搜索短链"
                  placeholder="搜索路径、标题或目标网址"
                /><button :disabled="linksBusy">搜索</button>
              </form>
            </div>
            <div class="table-scroll">
              <table class="links-table">
                <thead>
                  <tr>
                    <th>短链 / 目标网址</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th class="align-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="link in list" :key="link.id">
                    <td>
                      <div class="link-title">
                        <a :href="shortUrl(link.slug)" target="_blank" rel="noopener noreferrer"
                          >/s/{{ link.slug }} <span>↗</span></a
                        ><small v-if="link.title">{{ link.title }}</small>
                      </div>
                      <div class="target-url" :title="link.target">{{ link.target }}</div>
                    </td>
                    <td>
                      <button
                        class="status-pill"
                        :class="link.enabled ? 'enabled' : 'disabled'"
                        :disabled="mutating"
                        @click="toggle(link)"
                      >
                        <i></i>{{ link.enabled ? '启用中' : '已停用' }}
                      </button>
                    </td>
                    <td class="date-cell">
                      {{ new Date(link.created_at).toLocaleDateString('zh-CN') }}
                    </td>
                    <td>
                      <div class="row-actions">
                        <button @click="copy(link)">复制</button
                        ><button @click="openEditor(link)">编辑</button
                        ><button
                          @click="
                            linkId = link.id;
                            navigate('stats');
                          "
                        >
                          统计</button
                        ><button
                          class="danger-text"
                          @click="
                            deleting = link;
                            deleteDialog?.showModal();
                          "
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="!list.length" class="empty-state">
              <span class="empty-icon">↗</span>
              <h3>{{ query ? '没有找到匹配的短链' : '你的下一个连接，从这里开始' }}</h3>
              <p>
                {{
                  query
                    ? '试试其他路径、标题或网址。'
                    : '创建第一个短链，为它取一个容易记住的名字。'
                }}
              </p>
              <button v-if="!query" class="secondary" @click="openEditor()">创建第一个短链</button>
            </div>
            <div class="pagination">
              <span>{{ linksBusy ? '正在加载…' : `共 ${total} 个短链 · 第 ${page} 页` }}</span>
              <div>
                <button
                  :disabled="page <= 1 || linksBusy"
                  @click="
                    page--;
                    loadLinks();
                  "
                >
                  ← 上一页</button
                ><button
                  :disabled="page * 20 >= total || linksBusy"
                  @click="
                    page++;
                    loadLinks();
                  "
                >
                  下一页 →
                </button>
              </div>
            </div>
          </section>
          <p class="footnote"><span>ⓘ</span> 修改、停用或删除后，最多 60 秒在所有节点生效。</p>
        </template>

        <template v-if="tab === 'stats'">
          <div class="page-heading">
            <div>
              <span class="eyebrow">BEHIND EVERY CLICK</span>
              <h1>看见每一次抵达。</h1>
              <p>从访问趋势到访客明细，了解你的链接如何被使用。</p>
            </div>
          </div>
          <div v-if="system?.mode === 'economy'" class="info-banner">
            当前为经济模式，暂停记录新访问；已有统计仍可查询。
          </div>
          <form class="filter-bar" @submit.prevent="loadStats">
            <label
              >开始日期<input
                v-model="from"
                type="date"
                :min="system?.earliestDay"
                :max="to"
                :disabled="statsBusy"
                required /></label
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
            ><button class="primary" :disabled="statsBusy">
              {{ statsBusy ? '正在查询…' : '查询统计' }}
            </button>
          </form>
          <div v-if="archiveLoading" class="info-banner progress-banner">
            <span>正在读取历史归档 · {{ progress }}%</span
            ><progress :value="progress" max="100"></progress
            ><button @click="cancelJob('stats')">取消</button>
          </div>
          <p v-if="partial" class="footnote">历史归档尚未全部加载，当前数字为部分结果。</p>
          <div class="overview-grid stats-metrics">
            <section class="metric">
              <span>访问次数 · PV</span><strong>{{ number(pv) }}</strong>
              <p>{{ appliedQuery.from }} — {{ appliedQuery.to }}</p>
            </section>
            <section class="metric">
              <span>日均独立访客 · UV</span><strong>{{ number(averageUv) }}</strong>
              <p>按 IP 与 User-Agent 每日去重</p>
            </section>
            <section class="metric accent">
              <span>历史归档</span><strong>{{ coldDays.length }}<small>天</small></strong>
              <p>在浏览器中解压分析历史访问</p>
            </section>
          </div>
          <section class="panel chart-panel">
            <div class="panel-toolbar">
              <h2>访问趋势</h2>
              <span class="chart-legend"><i></i> 每日访问次数</span>
            </div>
            <div class="chart-wrap">
              <svg viewBox="0 0 760 180" role="img" aria-label="每日访问次数柱状图">
                <line
                  v-for="y in [20, 65, 110, 155]"
                  :key="y"
                  x1="0"
                  :y1="y"
                  x2="760"
                  :y2="y"
                  stroke="#e8ece8"
                />
                <rect
                  v-for="(day, index) in chartDays"
                  :key="day.day"
                  :x="(index * 760) / chartDays.length + 2"
                  :y="155 - (day.pv / maxPv) * 130"
                  :width="Math.max(1, 760 / chartDays.length - 4)"
                  :height="Math.max(day.pv ? 2 : 0, (day.pv / maxPv) * 130)"
                  rx="3"
                  fill="#3e7966"
                >
                  <title>{{ day.day }} · PV {{ day.pv }} · UV {{ day.uv }}</title>
                </rect>
              </svg>
              <div class="chart-labels">
                <span>{{ appliedQuery.from }}</span
                ><span>{{ appliedQuery.to }}</span>
              </div>
              <p v-if="!pv" class="muted center">所选时间范围暂无已记录的访问</p>
            </div>
          </section>
          <div class="breakdown-grid">
            <section v-for="group in breakdowns" :key="group.label" class="panel breakdown">
              <h2>{{ group.label }}</h2>
              <div v-for="item in group.values.slice(0, 6)" :key="item.name" class="breakdown-row">
                <div>
                  <span>{{ item.name || group.empty }}</span
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
              <p v-if="!group.values.length" class="muted">暂无数据</p>
            </section>
          </div>
          <section class="panel">
            <div class="panel-toolbar">
              <h2>访问明细 <small>UTC 日期</small></h2>
              <input
                v-model="detailDay"
                aria-label="明细日期"
                type="date"
                :min="system?.earliestDay"
                :max="today"
                @change="loadEvents(true)"
              />
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>访问时间</th>
                    <th>短链</th>
                    <th>IP / 地区</th>
                    <th>来源</th>
                    <th>浏览器 / 设备</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="event in events" :key="event.id">
                    <td class="nowrap">{{ time(event.occurred_at) }}</td>
                    <td>/s/{{ event.slug }}</td>
                    <td>
                      <span class="mono">{{ event.ip || '未知' }}</span
                      ><small class="cell-secondary">{{
                        [event.country, event.region, event.city].filter(Boolean).join(' · ') ||
                        '未知地区'
                      }}</small>
                    </td>
                    <td>{{ event.referer || '直接访问' }}</td>
                    <td>
                      {{ event.browser }}<small class="cell-secondary">{{ event.device }}</small>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="!events.length" class="compact-empty">
              {{ detailBusy ? '正在加载明细…' : '该日暂无已记录的访问' }}
            </div>
            <div class="pagination">
              <span>{{ detailBusy ? '正在读取…' : `第 ${eventPage} 页` }}</span>
              <div>
                <button
                  :disabled="eventPage <= 1 || detailBusy"
                  @click="
                    eventPage--;
                    loadEvents();
                  "
                >
                  ← 上一页</button
                ><button
                  :disabled="!hasMore || detailBusy"
                  @click="
                    eventPage++;
                    loadEvents();
                  "
                >
                  下一页 →
                </button>
              </div>
            </div>
          </section>
        </template>

        <template v-if="tab === 'archives'">
          <div class="page-heading">
            <div>
              <span class="eyebrow">A LITTLE HISTORY</span>
              <h1>旧的访问，也有迹可循。</h1>
              <p>超过 14 天的访问按日压缩归档，随时回看。</p>
            </div>
            <button class="secondary" :disabled="archivesBusy" @click="loadArchives()">
              ↻ 刷新状态
            </button>
          </div>
          <div class="overview-grid">
            <section class="metric">
              <span>归档检查间隔</span><strong>20<small>分钟</small></strong>
              <p>自动分批处理，失败后继续重试</p>
            </section>
            <section class="metric">
              <span>统计保留时间</span><strong>{{ system?.retentionDays }}<small>天</small></strong>
              <p>含今天在内的 UTC 日期</p>
            </section>
            <section class="metric accent">
              <span>待归档访问</span
              ><strong>{{ number(system?.backlog ?? 0) }}<small>条</small></strong>
              <p>源数据将在归档成功后清理</p>
            </section>
          </div>
          <section class="panel maintenance-card">
            <div>
              <span class="status-dot"></span><strong>最近成功处理</strong>
              <p>{{ time(system?.maintenance.last_success_at ?? null) }}</p>
            </div>
            <div>
              <strong>最近检查</strong>
              <p>{{ time(system?.maintenance.last_run_at ?? null) }}</p>
            </div>
            <p v-if="system?.maintenance.last_error" class="error">
              {{ system.maintenance.last_error }}
            </p>
          </section>
          <section class="panel">
            <div class="panel-toolbar">
              <h2>归档目录</h2>
              <span class="muted">按 UTC 日期组织</span>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>访问日期</th>
                    <th>状态</th>
                    <th>访问记录</th>
                    <th>压缩体积</th>
                    <th class="align-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in archiveRows" :key="day.day">
                    <td class="mono">{{ day.day }}</td>
                    <td>
                      <span
                        class="status-pill"
                        :class="day.status === 'cleaned' ? 'enabled' : 'disabled'"
                        >{{ archiveLabel(day.status) }}</span
                      >
                    </td>
                    <td>{{ number(day.row_count) }}</td>
                    <td>{{ (day.byte_count / 1024).toFixed(1) }} KB</td>
                    <td class="align-right">
                      <button
                        :disabled="!['published', 'cleaned'].includes(day.status)"
                        @click="
                          from = day.day;
                          to = day.day;
                          detailDay = day.day;
                          linkId = '';
                          navigate('stats');
                        "
                      >
                        查看访问 →
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="!archiveRows.length" class="empty-state">
              <span class="empty-icon">▤</span>
              <h3>历史会慢慢积累</h3>
              <p>超过 14 天的访问将自动出现在这里。</p>
            </div>
            <div class="pagination">
              <span>第 {{ archivePage }} 页</span>
              <div>
                <button
                  :disabled="archivePage <= 1 || archivesBusy"
                  @click="
                    archivePage--;
                    loadArchives();
                  "
                >
                  ← 上一页</button
                ><button
                  :disabled="archiveRows.length < 50 || archivesBusy"
                  @click="
                    archivePage++;
                    loadArchives();
                  "
                >
                  下一页 →
                </button>
              </div>
            </div>
          </section>
        </template>
        <footer>折径 <span>·</span> KEEP YOUR LINKS SIMPLE</footer>
      </div>
    </main>
    <dialog ref="editDialog" class="edit-dialog" @cancel="!mutating || $event.preventDefault()">
      <form @submit.prevent="save">
        <div class="dialog-heading">
          <div>
            <span class="eyebrow">A NEW CONNECTION</span>
            <h2>{{ editingId ? '编辑短链' : '创建短链' }}</h2>
          </div>
          <button type="button" aria-label="关闭" :disabled="mutating" @click="editDialog?.close()">
            ×
          </button>
        </div>
        <label for="target">目标网址 <span>*</span></label
        ><input
          id="target"
          v-model="form.target"
          type="url"
          placeholder="https://example.com/your-destination"
          maxlength="2048"
          required
        /><label for="slug">自定义路径</label>
        <div class="input-prefix">
          <span>/s/</span
          ><input
            id="slug"
            v-model="form.slug"
            placeholder="campaign/summer（留空自动生成）"
            maxlength="256"
            :required="!!editingId"
            pattern="[A-Za-z0-9_\-]+(/[A-Za-z0-9_\-]+)*"
          />
        </div>
        <p class="field-help">支持字母、数字、-、_ 和多层路径，区分大小写。</p>
        <label for="title">标题 <small>可选，仅后台可见</small></label
        ><input
          id="title"
          v-model="form.title"
          maxlength="120"
          placeholder="给这个链接写个备注"
        /><label class="checkbox"
          ><input v-model="form.enabled" type="checkbox" /> 启用这个短链</label
        >
        <p v-if="formError" class="error" role="alert">{{ formError }}</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="mutating" @click="editDialog?.close()">
            取消</button
          ><button class="primary" :disabled="mutating">
            {{ mutating ? '正在保存…' : '保存短链' }}
          </button>
        </div>
      </form>
    </dialog>
    <dialog ref="deleteDialog">
      <div class="dialog-heading"><h2>删除这个短链？</h2></div>
      <p class="muted">/s/{{ deleting?.slug }} 将在最多 60 秒内停止跳转，历史访问统计会保留。</p>
      <div class="dialog-actions">
        <button class="secondary" :disabled="mutating" @click="deleteDialog?.close()">取消</button
        ><button class="danger-button" :disabled="mutating" @click="remove">
          {{ mutating ? '正在删除…' : '确认删除' }}
        </button>
      </div>
    </dialog>
  </div>
  <div v-if="notice" class="toast" role="status"><span>✓</span>{{ notice }}</div>
</template>

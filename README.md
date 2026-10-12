# 折径 · Cloudflare Worker 短链系统

支持多层自定义路径 `/s/campaign/summer`、管理后台、访问统计，以及 D1 → R2 压缩归档。使用 TypeScript、Hono、Vue 3 和 Vite，后台静态资源与 API 部署在同一个 Worker。

## 本地启动

需要 Node.js 22 或更新版本。

```bash
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：设置管理员密码和至少 32 字符的随机 SESSION_SECRET
npm run build
npm run db:local
npm run dev
```

打开 `http://localhost:5173/admin/`。Vite 将 API 和 `/s/*` 请求转发到本地 Worker（8787 端口）；也可打开 `http://localhost:8787/admin/` 检查构建后的完整站点。请使用 `localhost`，保证浏览器能够在本地使用 Secure Cookie。

`.dev.vars`、本地 D1/R2 数据与构建产物均已忽略，不会提交到 Git。

## 部署到 Cloudflare

1. 开通 R2，然后创建资源：

   ```bash
   npx wrangler login
   npx wrangler d1 create shorten-url
   npx wrangler r2 bucket create shorten-url-archives
   ```

2. 将返回的 D1 `database_id` 填入 `wrangler.jsonc`，必要时调整 Worker、数据库和桶名称。桶使用 **Standard** 存储并保持私有。

3. 配置生产密钥、应用数据库迁移并部署：

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npm run db:remote
   npm run deploy
   ```

4. 通过 Worker 的域名访问 `/admin/`。使用自定义域名时，将整个域名交给此 Worker，确保 `/admin/*`、`/api/*` 和 `/s/*` 都能到达。登录限流绑定的 `namespace_id` 应在账户内与其他应用区分。

仓库中的数据库 ID 是占位值。执行上述命令前应先替换配置；本项目不会自动创建云端资源或升级套餐。

## 变量与模式

| 配置                   | 默认值    | 说明                                                 |
| ---------------------- | --------- | ---------------------------------------------------- |
| `MODE`                 | `economy` | `economy` 或 `detailed`；两种模式共用链接与后台      |
| `STATS_RETENTION_DAYS` | `180`     | 15～36500；含今天在内的 UTC 日期数                   |
| `ARCHIVE_BATCH_SIZE`   | `500`     | 1～500；上传批次记录上限                             |
| `ARCHIVE_MAX_KB`       | `512`     | 16～16384 KB；单分片未压缩大小上限，1 KB = 1024 字节 |
| `ADMIN_PASSWORD`       | Secret    | 管理员密码，建议使用随机长密码                       |
| `SESSION_SECRET`       | Secret    | 至少 32 字符，用于签名会话                           |

可以在 Worker 设置中修改变量并部署新版本，也可以编辑 `wrangler.jsonc` 后部署。CLI 部署会使用文件中的变量，请保持配置一致。修改任一 Secret 都会使旧登录会话失效；会话最长持续 12 小时。

例如，将 `ARCHIVE_MAX_KB` 设为 `1024`，即可把归档分片上限调整为 1024 KB（1 MiB）。配置单位为 KB，内部按 1 KB = 1024 字节换算，限制 gzip 压缩前的 UTF-8 NDJSON 大小，包含文件头和换行；与 `ARCHIVE_BATCH_SIZE` 同时生效，先达到任一上限即分片。R2 中实际存储的是压缩后的文件，通常会更小。

**经济模式：** 不记录新访问、不更新点击计数。内部映射缓存命中后，跳转不访问 D1/R2；未命中时执行一次带唯一索引的 D1 查询。后台管理和已有统计查询照常可用。

**详细模式：** 使用相同映射缓存，每次成功 GET 跳转通过 `waitUntil()` 插入一条访问明细。缓存命中同样记录。HEAD 不计数。统计失败不阻断已解析的跳转，但异步采集可能丢失事件；D1 不可用且缓存未命中时返回 503。

切回经济模式会停止新访问采集，已有统计的归档与清理继续运行。后台为当前选择的时间范围展示已记录数据，经济模式期间的访问不会补录。

## 短链与缓存规则

- 自定义路径支持大小写字母、数字、`-`、`_` 及 `/` 分层，区分大小写，总长不超过 256 字符；禁止空段、编码分隔符和路径穿越。
- 路径留空时生成 8 位随机短码；唯一约束处理并发冲突。
- 默认 302 跳转，仅支持 HTTP/HTTPS 目标；目标中的查询参数保留，访问短链携带的参数不向目标追加。禁止本站短链相互指向，避免循环。
- 映射缓存 60 秒，不存在的结果缓存 10 秒。响应使用 `Cache-Control: no-store`，不让浏览器永久记住跳转。不要为 `/s/*` 配置绕过 Worker 的整页缓存规则，否则会漏记统计。
- 管理修改清理当前节点缓存，其他节点按 TTL 更新。缓存中的绝对过期时间防止延迟回填把旧值重新延长 60 秒。
- 删除采用墓碑保留历史归属；路径可重新使用，新链接获得新的 ID。超过统计保留期的旧墓碑在空闲维护轮次清理。

## 统计与历史归档

明细包含原始 IP、UTC 时间、当时短链路径、Cloudflare 提供的地区、来源域名、User-Agent、浏览器及设备类别。来源 URL 的路径和参数不保存，User-Agent 最多 512 字符。浏览器/设备分类为轻量规则，未知值归入“其他”。所有成功 GET 均计入 PV，包括机器人和预览请求。

每日 UV 按 `IP + User-Agent` 去重，是访客估计值；缺少 IP 的访问计入 PV，不计入 UV。界面展示日均 UV，不将跨日 UV 相加称为独立访客数。每日分组使用 UTC，明细时间按浏览器本地时区展示。

维护任务固定为 `*/20 * * * *`，每天 72 次，每次推进一个有限阶段：

1. 优先清理已过期归档（最多 100 个对象），再清理超出总保留期限的 D1 记录。
2. 清理已发布归档对应的 D1 明细，每批最多 1000 条。
3. 对超过 14 个完整 UTC 日的最早日期进行上传，默认每批最多 500 条、512 KB 未压缩数据，分别由 `ARCHIVE_BATCH_SIZE` 和 `ARCHIVE_MAX_KB` 控制。
4. 全日上传完成后发布目录，下一轮才允许删除源明细。

R2 格式为 `analytics/v1/YYYY/MM/DD/part-000000.jsonl.gz`。第一行是 `{ "schemaVersion": 1, "day": "YYYY-MM-DD" }`，后续每行一条访问事件。D1 保存日目录和分片边界、行数、SHA-256、压缩字节数。R2 上传使用校验和及条件写入；固定分片边界使更改批次大小后仍能恢复未完成上传。调整行数或字节上限只影响新分片，待重试分片按原边界完成，即使其大小超过调低后的新上限。

维护租约为 2 分钟，D1 状态更新检查令牌。失败保留源数据和检查点，下次自动重试。归档期间仍读取 D1；全日发布后按日改读 R2，即使源记录尚未清理也不会重复计数。后台显示待归档条数、最近运行/成功时间和错误。

浏览器经鉴权接口逐片下载私有 R2 数据，Web Worker 校验、解压和聚合。仅保留单日去重集合；历史明细按日分页，翻页可能重复读取分片，允许查询较慢。可以取消历史汇总；取消后界面明确标识部分结果。归档和明细不保存到 localStorage/IndexedDB。

保留时间采用 UTC 日期：默认保存含今天在内的 180 天。超期日期先禁止访问，再由维护任务物理删除。缩短保留时间会在后续维护中永久删除旧数据；延长时间不能恢复已删除数据。数据库备份或 D1 Time Travel 的保留由 Cloudflare 另外管理。

## 免费额度与性能边界

- [Workers 免费限制](https://developers.cloudflare.com/workers/platform/limits/)：每日 10 万请求，HTTP 和 Cron 均为 10ms CPU；Cache API 命中仍执行 Worker。网络等待不计 CPU。
- [D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)：每日 500 万读取行、10 万写入行；索引维护、归档删除和后台查询都会消耗额度。`batch()` 减少往返，不减少写入行数。[免费单库上限为 500MB](https://developers.cloudflare.com/d1/platform/limits/)。
- [R2 Standard 免费额度](https://developers.cloudflare.com/r2/pricing/)：每月 10GB-month、100 万 A 类操作、1000 万 B 类操作。开通 R2 后超额使用会计费。免费额度是账户共享额度。

默认面向每日不超过 1 万次访问。集成测试验证一万条标准记录可以在 72 次调度内完成上传、发布和清理；超长字段、其他项目共享配额、频繁统计查询或异常流量会影响实际可用量。统计查询按所选日期扫描索引范围，请避免频繁自动刷新长时间范围。

**本地 Miniflare 不证明 Cloudflare 免费套餐的实际 CPU/计费指标。** 上线前应在测试环境观察 Worker CPU、`exceededCpu`、D1 `rows_read` / `rows_written`、数据库体积和归档积压。默认上传批次需要通过真实环境验证；降低批次后必须同时检查每天 72 次能否跟上新增量。平台额度耗尽时可能影响未命中缓存的跳转。

## 验证与接口

Worker 的环境绑定和运行时类型由 `wrangler types` 生成，保存在 `worker-configuration.d.ts`，随代码提交，不要手动修改。修改 `wrangler.jsonc` 中的绑定、兼容日期或兼容标志，或升级 Wrangler 后，运行：

```bash
npm run cf-typegen
```

`dev:worker` 和 `typecheck` 会自动生成类型，`build`、`check`、`deploy` 通过 `typecheck` 执行此步骤。CI 会先运行 `npm run cf-typegen -- --check` 检查生成文件是否需要更新。

生成时使用 `--strict-vars=false`，让 `MODE` 等可调整变量保持 `string` 类型。两个 Secret 的名称由 `wrangler.jsonc` 的 `secrets.required` 声明，因此生成类型不依赖本地 `.dev.vars`；Secret 值仍通过 `.dev.vars` 或 `wrangler secret put` 设置。

```bash
npm run check
# 仅打包检查 Worker，不部署
npx wrangler deploy --dry-run
```

集成测试在真实 workerd/Miniflare 运行时使用本地 D1、R2、Cache API 和限流绑定，覆盖 CRUD、鉴权、两种模式、缓存到期、统计口径、故障恢复、归档发布、保留期限以及每日一万条吞吐。故障注入和维护测试入口仅存在于测试打包内容，不部署到生产。

界面交互使用 Chrome MCP 验证，不依赖 Playwright。Wrangler 本地开发不会自动触发 Cron；需要手动检查时，访问 `http://localhost:8787/cdn-cgi/local/scheduled`，每次推进一个维护阶段。

| 接口                                                                     | 作用                               |
| ------------------------------------------------------------------------ | ---------------------------------- |
| `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/session` | 登录、退出、检查会话               |
| `GET/POST /api/admin/links`                                              | 分页搜索、新增短链                 |
| `GET/PUT/DELETE /api/admin/links/:id`                                    | 查看、编辑、删除                   |
| `GET /api/admin/status`                                                  | 当前模式、保留配置及维护状态       |
| `GET /api/admin/stats?from=&to=&linkId=`                                 | D1 汇总及已发布的归档日期          |
| `GET /api/admin/stats/events?day=&linkId=&cursor=`                       | 单日明细游标分页；已归档时返回 409 |
| `GET /api/admin/archives?page=`                                          | 日归档目录                         |
| `GET /api/admin/archives/:day?after=`                                    | 已发布分片列表                     |
| `GET /api/admin/archives/:day/parts/:part`                               | 鉴权读取 gzip 分片                 |

所有管理接口使用签名 Cookie。写操作必须携带同源 `Origin` 和 `application/json` 对象；DELETE 也需提交 `{}`。不开放公共创建接口或任意 R2 对象读取入口。

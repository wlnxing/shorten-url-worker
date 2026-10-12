# 开发指南

[返回项目首页](../README.md) · [实现说明](architecture.md) · [配置与运维](operations.md) · [OpenAPI](openapi.yaml)

## 本地运行

需要 Node.js 22 或更新版本。前端使用 Vue 3 和 Vite，Worker 使用 TypeScript 和 Hono；D1、R2 和 Cache API 由 Wrangler 的本地运行时提供。

```bash
npm ci
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars` 中的两个 Secret：`ADMIN_PASSWORD` 为本地管理员密码，`SESSION_SECRET` 为至少 32 字符的随机字符串。模式和归档参数修改 `wrangler.jsonc` 的 `vars`；项目声明了 `secrets.required`，因此 `.dev.vars` 只用于声明过的 Secret。

```bash
npm run build
npm run db:local
npm run dev
```

打开 `http://localhost:5173/admin/` 进行前端开发。Vite 将 `/api/*` 和 `/s/*` 转发到 8787 端口，并将合法的开发站点 Origin 转换为 Worker Origin；其他来源仍会被拒绝。请使用 `localhost`，以便浏览器在本地接受 Secure Cookie。

`http://localhost:8787/admin/` 用于检查 `dist/` 中的构建结果；修改前端后重新执行 `npm run build` 才会更新这个入口。本地 D1/R2 数据位于 `.wrangler/`，与云端资源分离；`db:remote` 和 `deploy` 会操作云端。

## 项目结构

| 路径                                 | 职责                            |
| ------------------------------------ | ------------------------------- |
| `src/worker/index.ts`                | API 中间件、路由和定时任务入口  |
| `src/worker/auth.ts`                 | 登录、Cookie 会话与同源校验     |
| `src/worker/links.ts`、`redirect.ts` | 短链管理、映射缓存和跳转        |
| `src/worker/visits.ts`、`stats.ts`   | 访问采集、汇总、明细与归档查询  |
| `src/worker/archive.ts`              | D1 → R2 归档、重试及过期清理    |
| `src/web/`                           | 后台页面及浏览器归档处理 Worker |
| `src/shared/types.ts`                | 前后端共用的数据结构            |
| `migrations/`                        | D1 数据库迁移                   |
| `public/`、`admin/index.html`        | 静态资源、响应头及页面入口      |
| `worker-configuration.d.ts`          | Wrangler 生成的绑定和运行时类型 |
| `tests/integration.test.ts`          | workerd/Miniflare 集成测试      |
| `docs/openapi.yaml`                  | 对外接口定义                    |

## 绑定与类型

`src/worker/env.ts` 使用 `Cloudflare.Env`，类型来自 `worker-configuration.d.ts`。修改绑定、兼容日期或兼容标志，或升级 Wrangler 后，运行：

```bash
npm run cf-typegen
```

生成文件随代码提交，不手工修改。`--strict-vars=false` 使可调整变量保持 `string` 类型；Secret 名称来自 `wrangler.jsonc` 的 `secrets.required`，生成类型不依赖本地密码。

`typecheck` 会先生成类型，`build`、`check` 和 `deploy` 间接执行这一步。单独执行 `dev:worker` 时由 Wrangler 启动开发服务；如需提前检查生成文件是否过期，可运行：

```bash
npm run cf-typegen -- --check
```

## 验证

```bash
npm run check
npx wrangler deploy --dry-run
```

`check` 执行类型检查、前端构建和集成测试；`--dry-run` 检查 Worker 打包与绑定，不发布新版本。检查文档格式时运行 `npx prettier --check README.md docs`。

集成测试在真实 workerd/Miniflare 运行时使用本地 D1、R2、Cache API 和限流绑定，覆盖：

- 鉴权、同源限制、会话失效、路径校验与短链 CRUD。
- 经济模式缓存命中的零存储调用、详细模式采集和每日 UV。
- 归档发布前保留源数据、上传失败恢复、调整行数/KB 上限后的重试。
- UTF-8 字节边界、保留期限以及每日一万条记录在 72 次调度内完成归档。

测试包装器的 `X-Test-*` 请求头和 `/__test/*` 入口仅在测试打包时加入，生产代码不提供这些接口。界面交互使用 Chrome MCP 验证，包括管理操作、归档解压与分页、手机布局；不使用 Playwright。

Wrangler 本地开发不会自动触发 Cron。开发服务启动后，可手动执行一个维护阶段：

```bash
curl http://localhost:8787/cdn-cgi/local/scheduled
```

每次请求只推进一个阶段，上传、发布和删除源明细可能需要多次调用；生产调度间隔为 20 分钟。

## 维护接口文档

[openapi.yaml](openapi.yaml) 使用 [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0.html)，描述生产 HTTP 接口。修改路由、校验或响应类型时，同步更新对应操作、Schema 和示例。

该文件可直接导入支持 OpenAPI 3.1 的文档或调试工具。浏览器调试需要同源部署及有效登录 Cookie；跨域文档页面无法直接调用写接口。程序化调用应先登录，保存返回的 Cookie，并在 POST、PUT、DELETE 请求中提供与服务地址一致的 `Origin` 和 JSON 对象。

OpenAPI 中的 `/s/{slug}` 描述单层短码。实际 Worker 也支持 `/s/campaign/summer` 等任意层数路径；调用时保留路径中的 `/`，不要将整个多层路径编码为含 `%2F` 的单个参数。

## 数据库变更

通过新的迁移文件演进表结构，先执行 `npm run db:local` 验证，再按部署流程应用云端迁移。结构、索引、归档状态转换和数据保留边界见[实现说明](architecture.md)。

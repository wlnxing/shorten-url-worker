# shorten url · 你的短链工作台

shorten url 是一个部署在 Cloudflare Workers 上的短链系统。用自己的域名创建、管理和分享短链接，按需开启访问统计，无需维护服务器。

```text
https://example.com/a/very/long/address
                  ↓
https://go.example.com/s/summer
```

## 特点

- **自定义短链**：支持 `/s/summer`、`/s/campaign/summer` 等多层路径，也可以自动生成短码。
- **两种运行模式**：经济模式减少读写，详细模式记录访问；切换模式后仍可管理全部短链。
- **完整管理后台**：创建、搜索、编辑、停用、删除和复制短链，支持手机访问。
- **访问统计**：查看 PV、日均 UV、地区、来源、浏览器、设备及访问明细，可按短链和日期筛选。
- **历史归档**：近期记录保存在 D1，超过 14 天按日压缩归档到 R2；每 20 分钟处理一次，后台可直接查询历史数据。
- **围绕免费额度设计**：跳转使用缓存，统计按需开启，旧数据自动归档。实际用量与费用取决于访问量和查询频率，参见[额度说明](docs/operations.md#免费额度与容量)。

## 部署

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wlnxing/shorten-url-worker)

准备好 Cloudflare 和 GitHub 账号，并先在 Cloudflare 中开通 R2，无需在本机安装开发环境。

1. 点击上方按钮，连接 GitHub，按提示将项目复制到自己的账号。
2. 确认 Worker、D1 数据库和 R2 存储桶的名称，按需选择 `MODE`：`economy` 为经济模式，`detailed` 为详细模式。
3. 填写 `ADMIN_PASSWORD`（后台密码）和 `SESSION_SECRET`（至少 32 字符的随机字符串），使用不同的值并妥善保存。
4. 保留自动识别的构建、部署命令，点击部署。Cloudflare 会创建并绑定存储资源，项目会自动初始化数据库、构建后台并发布。
5. 部署完成后，打开提供的 `https://<Worker 名称>.<账号子域名>.workers.dev/admin/`，使用刚设置的密码登录。

后续也可以绑定自己的域名。更新通过部署流程生成的仓库时，请保留其中的资源绑定和配置；更多说明见[配置与运维](docs/operations.md#一键部署与持续更新)。

### 手动部署

准备一个 Cloudflare 账号，开通 R2，并在本机安装 Node.js 22 或更新版本。下载项目后，在项目目录执行以下步骤。

#### 1. 安装依赖并创建存储

```bash
npm ci
npx wrangler login
npx wrangler d1 create shorten-url
npx wrangler r2 bucket create shorten-url-archives
```

已有数据库或存储桶时，可以复用对应资源。R2 使用 Standard 存储，保持桶私有。

#### 2. 配置资源与访问域名

编辑 [wrangler.jsonc](wrangler.jsonc)：

- 将 `d1_databases[0].database_id` 的全零占位值替换为你刚创建的数据库 ID，确认数据库、R2 桶和 Worker 名称属于自己的账号。
- 默认启用 `workers_dev`，可直接使用部署后提供的 `workers.dev` 地址。
- 使用自定义域名时，在顶层添加如下 `routes`，将示例域名换成 Cloudflare 账号下的域名；若只使用自定义域名，可将 `workers_dev` 设为 `false`。[域名配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/#routes)

```jsonc
"routes": [{ "pattern": "go.example.com", "custom_domain": true }]
```

#### 3. 设置密码并部署

```bash
cp .dev.vars.example .env.production
```

编辑 `.env.production`，将 `ADMIN_PASSWORD` 换成管理员密码，将 `SESSION_SECRET` 换成至少 32 字符的随机字符串。此文件已被 Git 忽略，请妥善保存。

```bash
npm run deploy -- --secrets-file .env.production
```

部署命令会自动构建后台、应用数据库迁移并发布 Worker；首次部署会一起上传代码和两个 Secret，详情见 [Cloudflare 密钥说明](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)。之后更新项目，执行 `npm ci` 和 `npm run deploy` 即可；未修改密钥时，无需再次传入密钥文件。

#### 4. 登录后台

打开 `https://你的域名/admin/`，使用刚设置的管理员密码登录。短链和后台使用同一个域名。

## 使用

1. 在“短链管理”中点击“新建短链”，填写完整的 HTTP/HTTPS 目标网址。
2. 自定义路径填写 `summer` 或 `campaign/summer`，无需填写 `/s/`；留空则自动生成短码。路径支持英文字母、数字、`-`、`_` 和分层 `/`，区分大小写。
3. 保存后点击“复制”，即可分享短链。标题仅在后台显示，便于查找和整理。
4. 需要调整时，可编辑目标、停用或删除。修改最多需要 60 秒在所有节点生效；删除短链会保留已有访问统计。
5. 开启详细模式后，在“访问统计”中选择短链和日期；在“历史归档”中查看旧记录。历史查询需要下载并解压归档，加载会比近期数据慢。

### 选择模式

在 `wrangler.jsonc` 的 `vars.MODE` 中选择模式，然后执行 `npm run deploy`。两种模式均支持短链的全部管理功能。

| 模式     | 配置值     | 适合的用途                                           |
| -------- | ---------- | ---------------------------------------------------- |
| 经济模式 | `economy`  | 只需短链跳转；缓存命中时不读写数据库，也不记录新访问 |
| 详细模式 | `detailed` | 需要了解访问情况；跳转时记录访问，后台可查看统计     |

切回经济模式后，已有统计仍可查看，归档继续运行。经济模式期间的访问不会补录。

### 调整统计保留和归档大小

以下变量也在 `wrangler.jsonc` 的 `vars` 中设置，修改后重新部署：

| 变量                   | 默认值 | 作用                                                    |
| ---------------------- | ------ | ------------------------------------------------------- |
| `STATS_RETENTION_DAYS` | `180`  | 统计保留天数，包含今天；缩短后会自动清理超期数据        |
| `ARCHIVE_MAX_KB`       | `512`  | 单个归档分片的未压缩大小上限，单位 KB，1 KB = 1024 字节 |
| `ARCHIVE_BATCH_SIZE`   | `500`  | 每次上传的最多记录数，与大小上限共同生效                |

例如，`ARCHIVE_MAX_KB: "1024"` 表示每片最多 1024 KB。更多取值范围与调整建议见[配置与运维](docs/operations.md)。

详细模式会保存访问者的原始 IP 和设备信息。统计按 UTC 日期分组，明细时间按浏览器本地时区显示；UV 是按 IP 与浏览器信息每日去重的访客估计值。

## 文档

- [开发指南](docs/development.md)：本地运行、项目结构、类型生成与验证。
- [实现说明](docs/architecture.md)：缓存、统计口径、归档与故障恢复。
- [配置与运维](docs/operations.md)：变量、密钥、容量和常见问题。
- [OpenAPI 接口文档](docs/openapi.yaml)：鉴权、短链管理、统计与归档接口，可导入支持 OpenAPI 的工具。

# 配置与运维

[返回部署指南](../README.md#部署) · [开发指南](development.md) · [实现说明](architecture.md) · [OpenAPI](openapi.yaml)

## 配置参考

普通变量在 `wrangler.jsonc` 的 `vars` 中设置，Secret 通过密钥文件或 Cloudflare Secret 管理。下表默认值指程序在省略变量时使用的值，部署以你配置的实际值为准。

| 变量                   | 默认值      | 有效范围与含义                                     |
| ---------------------- | ----------- | -------------------------------------------------- |
| `MODE`                 | `economy`   | `economy` 或 `detailed`；控制新访问是否记录        |
| `STATS_RETENTION_DAYS` | `180`       | 整数 15～36500，包含今天的 UTC 日期数              |
| `ARCHIVE_BATCH_SIZE`   | `500`       | 整数 1～500，单次上传最多记录数                    |
| `ARCHIVE_MAX_KB`       | `512`       | 整数 16～16384，单分片压缩前上限；1 KB = 1024 字节 |
| `ADMIN_PASSWORD`       | 必填 Secret | 后台登录密码                                       |
| `SESSION_SECRET`       | 必填 Secret | 至少 32 字符，用于签名会话                         |

在 Cloudflare 控制台修改变量后需要部署新版本；后续 CLI 部署会重新使用文件中的变量，请同步保存配置。`ARCHIVE_MAX_KB` 包含 NDJSON 文件头、事件和换行；与记录数上限共同生效。R2 对象显示的是压缩后的大小。

模式切换不影响已有链接、已有统计的查询和定时维护。日归档在数据早于 14 个完整 UTC 日期后开始；总保留期限独立控制何时删除历史统计。

## 密钥与会话

首次部署使用 [README](../README.md#3-设置密码并部署) 的 `--secrets-file` 流程，一并提供代码和必填 Secret。更新已存在 Worker 的密码或签名密钥可以运行：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

会话最长有效 12 小时，修改任一 Secret 都会使旧会话失效。登录以来源 IP 限流，每 60 秒最多 5 次尝试；限流绑定的 `namespace_id` 应与同一账号的其他应用区分。

会话 Cookie 为 `__Host-short_session`，使用 `HttpOnly`、`Secure`、`SameSite=Strict` 和根路径。写接口要求同源 `Origin` 和 `application/json` 对象，请求体上限为 8192 字节。管理接口和归档下载都不允许缓存。

## 域名与部署更新

如果使用 `workers.dev`，将 `workers_dev` 设置为 `true`。如果只使用自己的域名，可将其设为 `false`，通过顶层 `routes` 配置 `custom_domain: true`。域名必须把后台、API 和短链请求一起交给该 Worker，不能只绑定 `/s/*`。

部署前确认 `database_id` 属于当前账号，并与准备迁移的数据库一致。不要照搬其他部署的数据库 ID。保留 R2 桶的私有访问设置，历史数据由登录后的 API 读取。

更新已有实例：

```bash
npm ci
npm run db:remote
npm run deploy
```

保留你的资源绑定、域名和变量配置；修改应用代码通常不需要重新创建 D1/R2。`.env.production`、`.dev.vars` 和本地 `.wrangler/` 数据均在 Git 忽略列表中。

## 免费额度与容量

本项目按每日不超过 1 万次访问设计，本地集成测试验证一万条标准记录可在每天 72 次调度内完成上传、发布和源数据清理。实际容量受记录大小、共享额度、后台查询频率和 Cloudflare CPU 限制影响。

| 服务        | 免费额度或限制                                                            | 官方说明                                                                                                                      |
| ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workers     | 每日 10 万次 Worker 请求；HTTP 与 Cron 每次 10 ms CPU，网络等待不计入 CPU | [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)                                                    |
| D1          | 每日 500 万读取行、10 万写入行；免费单库上限 500 MB                       | [计费](https://developers.cloudflare.com/d1/platform/pricing/)、[限制](https://developers.cloudflare.com/d1/platform/limits/) |
| R2 Standard | 每月 10 GB-month 存储、100 万 A 类操作、1000 万 B 类操作                  | [R2 计费](https://developers.cloudflare.com/r2/pricing/)                                                                      |

额度以 Cloudflare 当前政策为准，同一账号的其他应用也会消耗额度。R2 开通后超额使用会计费。映射缓存命中仍执行 Worker，但经济模式不会产生 D1/R2 请求；详细模式每次访问的插入、索引维护及后续删除都消耗 D1 写入额度，`batch()` 仅减少往返次数。

上线后观察 Worker CPU、`exceededCpu`、D1 的 `rows_read` / `rows_written`、数据库大小和后台的“待归档访问”。本地测试无法证明真实免费套餐的 CPU 与计费结果。若归档触及 CPU 限制，可调低批次行数或 KB 上限，同时确认每天 72 次调度能够处理新增记录。避免频繁刷新很长时间范围的统计，查询会扫描相应的索引范围。

## 常见问题

### 部署后无法打开后台

确认已启用 `workers.dev` 或绑定自定义域名，并访问 `/admin/`。当前配置可能关闭默认域名，只有 Worker 部署成功并不代表已有公开访问入口。

### 修改短链后仍跳转到旧地址

不同节点的映射缓存最多保留 60 秒。检查是否额外设置了针对 `/s/*` 的整页缓存或浏览器永久重定向缓存。

### 访问统计没有增加

确认 `MODE=detailed` 已部署生效，且访问使用 GET。经济模式和 HEAD 请求不采集统计；查看 Worker 日志中的 `visit_write_failed` 可判断 D1 写入是否失败。

### 超过 14 天的记录仍未归档

归档以完整 UTC 日期为单位，每次 Cron 只推进一个阶段。查看“历史归档”中的待处理数量、最近检查和错误，确认 Cron 已生效。上传、发布和清理需要不同的维护轮次。本地开发需[手动触发维护](development.md#验证)。

### 历史查询慢，或提示归档暂时不可用

历史查询会逐片下载和解压，翻页可能重复读取文件。检查当前日期的目录状态及对应 R2 对象是否存在。发生校验错误时，应先核对目录与对象的一致性，再从备份恢复匹配的数据；不要手动删除仍在归档中的 D1 源记录。

### 想缩短统计保留时间

降低 `STATS_RETENTION_DAYS` 后，超期日期会停止查询，并在后续维护中永久删除。需要保留的数据应在调整前备份；以后调大保留天数不能恢复已清理记录。备份时需同时保存 D1 归档目录和对应 R2 对象。

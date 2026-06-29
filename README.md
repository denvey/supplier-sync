# supplier-sync

`supplier-sync` 是一个 TypeScript 独立 Worker，用于通过 CJ Dropshipping 官方 API 同步商品索引数据。

当前 v1 只同步商品索引，不做网页爬虫，也不全量拉取商品详情、变体或库存。

## 技术栈

- Crawlee `BasicCrawler`：作为 API 请求执行器，负责请求调度、并发、重试和失败处理。
- PostgreSQL + Drizzle：保存账号、类目、仓库、商品索引、cursor 和 usage log。
- Redis：实现账号 QPS、IP QPS、本地点数预算和临时状态。
- Vitest：单元测试和可选集成测试。

## 快速开始

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm cj:auth:token
pnpm cj:sync:categories
pnpm cj:sync:index
```

推荐在 `.env` 中配置 `CJ_API_KEY`，然后执行 `pnpm cj:auth:token` 自动获取并保存 `accessToken` / `refreshToken` 到数据库。

如果你已经有可用 token，也可以继续手动配置 `CJ_ACCESS_TOKEN` 和 `CJ_REFRESH_TOKEN`。如果没有配置 `CJ_ACCOUNT_ID`，CLI 会根据 `.env` 自动创建或复用默认账号。

同步命令会从数据库读取 token。若 `accessToken` 接近过期且账号已有 `refreshToken`，客户端会自动调用 `/authentication/refreshAccessToken` 并更新数据库。

## 老账号限流说明

当前实现同时支持 QPS 和点数预算：

- 所有请求都会先经过账号 QPS 和 IP QPS 限流。
- 只有账号进入点数规则生效日期后，才会启用本地点数预算保护。

如果你是 2026-06-01 前注册的老账号，请保持：

```env
CJ_REGISTERED_AT=2026-05-31T00:00:00.000Z
```

这样在 `2026-07-01T00:00:00.000Z` 前，Worker 只会按 QPS/IP 限流运行；到 7 月 1 日后会自动启用点数预算保护。

按 CJ 老规则配置账号 QPS：

```env
CJ_ACCOUNT_QPS_LIMIT=1
```

参考值：

- Free / 等级 0-1：`1`
- Plus / 等级 2：`2`
- Prime / 等级 3：`4`
- Advanced / 等级 4-5：`6`

IP 总限制默认通过 `CJ_IP_QPS_LIMIT=10` 控制。

如果你不确定 CJ 实际给账号放开的 QPS，可以先把 `CJ_ACCOUNT_QPS_LIMIT` 配高一点试探。程序遇到非点数不足类 `429` 时会自动临时降档：

```text
6 -> 4 -> 2 -> 1
```

每次降档会按 `CJ_ADAPTIVE_COOLDOWN_MS` 冷却，后续请求会在 Redis 中等待。连续成功达到 `CJ_ADAPTIVE_RECOVERY_SUCCESSES` 后，会逐步恢复到你配置的 `CJ_ACCOUNT_QPS_LIMIT`。如果 429 是点数不足，程序不会靠降 QPS 继续硬跑。

## 常用命令

- `pnpm cj:sync:categories`：同步 `/product/getCategory`。
- `pnpm cj:auth:token`：使用 `CJ_API_KEY` 调用 `/authentication/getAccessToken`，并保存 token 到 `cj_accounts`。
- `pnpm cj:auth:refresh`：使用数据库中的 refresh token 或 `.env` 中的 `CJ_REFRESH_TOKEN` 刷新 token。
- `pnpm cj:sync:warehouses`：同步 `/product/globalWarehouseList`。
- `pnpm cj:sync:index`：按类目、国家仓库和时间窗口同步 `/product/listV2`。
- `pnpm cj:worker`：依次执行类目、仓库、商品索引同步。

## 配置项

主要环境变量见 `.env.example`：

- `DATABASE_URL`：PostgreSQL 连接地址。
- `REDIS_URL`：Redis 连接地址。
- `CJ_API_BASE_URL`：CJ API 基础地址。
- `CJ_API_KEY`：CJ API Key，用于通过 `pnpm cj:auth:token` 获取 token。
- `CJ_ACCESS_TOKEN`：CJ Access Token，可选；没有执行认证命令时可手动填写。
- `CJ_REFRESH_TOKEN`：CJ Refresh Token，可选；可用于 `pnpm cj:auth:refresh`。
- `CJ_REGISTERED_AT`：CJ 账号注册时间，用于判断点数规则生效时间。
- `CJ_ACCOUNT_QPS_LIMIT`：账号级 QPS。
- `CJ_IP_QPS_LIMIT`：IP 级总 QPS。
- `CJ_ADAPTIVE_COOLDOWN_MS`：遇到 CJ 429 后的账号级冷却时间，默认 `60000`。
- `CJ_ADAPTIVE_RECOVERY_SUCCESSES`：降速后连续成功多少次再尝试恢复上一档，默认 `120`。
- `CJ_SYNC_COUNTRY_MODE`：商品索引是否按仓库国家分片，默认 `none`，不向 CJ 传 `countryCode`；设为 `warehouse` 时按可用仓库 `countryCode` 分片。
- `CJ_SYNC_MIN_SELL_PRICE` / `CJ_SYNC_MAX_SELL_PRICE`：`/product/listV2` 价格区间过滤，默认最低价 `0.01`。
- `CJ_SYNC_MIN_WAREHOUSE_INVENTORY` / `CJ_SYNC_MAX_WAREHOUSE_INVENTORY`：仓库库存区间过滤，默认最低库存 `1`。
- `CJ_SYNC_VERIFIED_WAREHOUSE`：验证库存过滤，`all` / `verified` / `unverified`，默认 `verified`。
- `CJ_SYNC_PRODUCT_FLAG`：商品标识过滤，`all` / `trending` / `latest` / `video` / `unsalable`，默认 `trending`。
- `CJ_SYNC_FREE_SHIPPING_ONLY`：是否只同步包邮商品，默认 `false`。
- `CJ_SYNC_TIME_START`：商品索引初始化同步起始时间。
- `CJ_SYNC_TIME_END`：商品索引初始化同步结束时间，留空则使用当前时间。
- `CJ_MAX_CONCURRENCY`：Crawlee 最大并发数。

## 数据同步范围

v1 同步以下接口：

- `/authentication/getAccessToken`
- `/authentication/refreshAccessToken`
- `/product/getCategory`
- `/product/globalWarehouseList`
- `/product/listV2`

`/product/listV2` 默认参数策略：

- `size=100`
- `sort=asc`
- `orderBy=3`
- `features=enable_category`
- `startSellPrice=0.01`
- `startWarehouseInventory=1`
- `verifiedWarehouse=1`
- `productFlag=0`
- 默认按 `categoryId + timeStart/timeEnd` 分片，不传 `countryCode`
- 当 `CJ_SYNC_COUNTRY_MODE=warehouse` 时，改为按 `categoryId + countryCode + timeStart/timeEnd` 分片

当 `totalRecords` 接近或达到 CJ 文档中的 `6000` 上限，或页数风险超过 `1000` 页时，Worker 会自动二分时间窗口并继续同步。

不传仓库国家时，本地会用 `country_code = 'GLOBAL'` 保存商品索引，保证 `(account_id, pid, country_code)` 幂等键稳定。如果需要按仓库国家拆分，请先执行：

```bash
pnpm cj:sync:warehouses
```

## 数据表

当前迁移会创建：

- `cj_accounts`
- `cj_categories`
- `cj_warehouses`
- `cj_product_indexes`
- `cj_sync_cursors`
- `cj_api_usage_logs`
- `sync_tasks`

`cj_product_indexes` 使用 `(account_id, pid, country_code)` 做幂等键，重复同步会更新已有记录，不会插入重复商品。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

集成测试默认跳过，因为需要真实 PostgreSQL 和 Redis。启动本地服务后可以这样运行：

```bash
docker compose up -d
pnpm db:migrate
RUN_INTEGRATION=1 pnpm test
```

## 当前边界

- v1 不拉取全量商品详情。
- v1 不拉取全量变体。
- v1 不拉取全量库存。
- `sync_tasks.type` 已预留 `cj.product.detail`、`cj.variant.sync`、`cj.inventory.refresh`、`cj.webhook.event`，后续可以平滑扩展。
- CJ 点数规则按新账号 `2026-06-01` 生效、老账号 `2026-07-01` 生效建模。

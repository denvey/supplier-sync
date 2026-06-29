import { Redis } from "ioredis";
import { config } from "../../config.js";
import { createDb } from "../../db/client.js";
import { CjAccountService } from "./account-service.js";
import { CjApiClient } from "./cj-api-client.js";
import { CjMetadataSync } from "./cj-metadata-sync.js";
import { CjProductIndexer } from "./cj-product-indexer.js";
import { CjQuotaGate } from "./cj-quota-gate.js";
import { CjUsageLogger } from "./cj-usage-logger.js";

export function createRuntime() {
  const { db, client } = createDb();
  const redis = new Redis(config.REDIS_URL, { lazyConnect: false });
  const apiClient = new CjApiClient({
    db,
    baseUrl: config.CJ_API_BASE_URL
  });
  const quotaGate = new CjQuotaGate({
    redis,
    ipQpsLimit: config.CJ_IP_QPS_LIMIT,
    adaptiveCooldownMs: config.CJ_ADAPTIVE_COOLDOWN_MS,
    adaptiveRecoverySuccesses: config.CJ_ADAPTIVE_RECOVERY_SUCCESSES
  });
  const usageLogger = new CjUsageLogger(db);
  const metadataSync = new CjMetadataSync({ db, apiClient, quotaGate, usageLogger });
  const productIndexer = new CjProductIndexer({
    db,
    apiClient,
    quotaGate,
    usageLogger,
    maxConcurrency: config.CJ_MAX_CONCURRENCY,
    countryMode: config.CJ_SYNC_COUNTRY_MODE,
    listV2Filters: {
      minSellPrice: config.CJ_SYNC_MIN_SELL_PRICE,
      maxSellPrice: config.CJ_SYNC_MAX_SELL_PRICE,
      minWarehouseInventory: config.CJ_SYNC_MIN_WAREHOUSE_INVENTORY,
      maxWarehouseInventory: config.CJ_SYNC_MAX_WAREHOUSE_INVENTORY,
      verifiedWarehouse: config.CJ_SYNC_VERIFIED_WAREHOUSE,
      productFlag: config.CJ_SYNC_PRODUCT_FLAG,
      freeShippingOnly: config.CJ_SYNC_FREE_SHIPPING_ONLY
    },
    defaultTimeStart: config.CJ_SYNC_TIME_START,
    defaultTimeEnd: config.CJ_SYNC_TIME_END ?? new Date(),
    logger: console
  });
  const accountService = new CjAccountService(db);

  return {
    db,
    client,
    redis,
    apiClient,
    usageLogger,
    accountService,
    metadataSync,
    productIndexer,
    async close() {
      redis.disconnect();
      await client.end();
    }
  };
}

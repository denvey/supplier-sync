import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import {
  cjAccounts,
  cjApiUsageLogs,
  cjCategories,
  cjProductIndexes,
  cjSyncCursors,
  cjWarehouses,
  type CjAccount
} from "../src/db/schema.js";
import { CjApiClient } from "../src/integrations/cj/cj-api-client.js";
import { CjMetadataSync } from "../src/integrations/cj/cj-metadata-sync.js";
import { CjProductIndexer } from "../src/integrations/cj/cj-product-indexer.js";
import { CjQuotaGate } from "../src/integrations/cj/cj-quota-gate.js";
import { CjUsageLogger } from "../src/integrations/cj/cj-usage-logger.js";

const runIntegration = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!runIntegration)("CJ sync integration", () => {
  let db: Db;
  let pgClient: ReturnType<typeof createDb>["client"];
  let redis: Redis;
  let account: CjAccount;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    pgClient = created.client;
    redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
    await redis.flushdb();

    const [inserted] = await db.insert(cjAccounts).values({
      name: `integration-${Date.now()}`,
      accessToken: "test-token",
      registeredAt: new Date("2026-05-31T00:00:00.000Z"),
      qpsLimit: 20,
      pointsEffectiveAt: new Date("2026-07-01T00:00:00.000Z")
    }).returning();
    if (!inserted) throw new Error("Failed to create integration account");
    account = inserted;
  });

  afterAll(async () => {
    if (account) {
      await db.delete(cjApiUsageLogs).where(eq(cjApiUsageLogs.accountId, account.id));
      await db.delete(cjProductIndexes).where(eq(cjProductIndexes.accountId, account.id));
      await db.delete(cjSyncCursors).where(eq(cjSyncCursors.accountId, account.id));
      await db.delete(cjCategories).where(eq(cjCategories.accountId, account.id));
      await db.delete(cjWarehouses).where(eq(cjWarehouses.accountId, account.id));
      await db.delete(cjAccounts).where(eq(cjAccounts.id, account.id));
    }
    redis?.disconnect();
    await pgClient?.end();
  });

  it("syncs metadata and product indexes idempotently with mock CJ responses", async () => {
    const fetchImpl = async (url: string | URL) => {
      const path = new URL(String(url)).pathname;

      if (path.endsWith("/product/getCategory")) {
        return jsonResponse({
          code: 200,
          result: true,
          data: [{
            categoryFirstId: "first-1",
            categoryFirstName: "First",
            categoryFirstList: [{
              categorySecondId: "second-1",
              categorySecondName: "Second",
              categorySecondList: [{
                categoryId: "third-1",
                categoryName: "Third"
              }]
            }]
          }],
          requestId: "category-request"
        });
      }

      if (path.endsWith("/product/globalWarehouseList")) {
        return jsonResponse({
          code: 200,
          result: true,
          data: [{
            id: "1",
            areaId: 1,
            countryCode: "US",
            nameEn: "United States",
            areaEn: "US Warehouse",
            disabled: false
          }],
          requestId: "warehouse-request"
        });
      }

      if (path.endsWith("/product/listV2")) {
        return jsonResponse({
          code: 200,
          result: true,
          data: {
            pageSize: 100,
            pageNumber: 1,
            totalRecords: 1,
            totalPages: 1,
            content: [{
              productList: [{
                id: "pid-1",
                nameEn: "Test Product",
                sku: "SKU-1",
                spu: "SPU-1",
                bigImage: "https://example.test/image.jpg",
                sellPrice: "11.85",
                nowPrice: "9.50",
                categoryId: "third-1",
                threeCategoryName: "Third",
                createAt: 1609228800000,
                warehouseInventoryNum: 500,
                saleStatus: "3"
              }]
            }]
          },
          requestId: "list-request",
          pointsInfo: { usedToday: 50, remaining: 49950, total: 50000 }
        });
      }

      return jsonResponse({ code: 404, result: false, data: null, message: "Not found" }, 404);
    };

    const apiClient = new CjApiClient({
      db,
      baseUrl: "https://mock-cj.test/api2.0/v1",
      fetchImpl: fetchImpl as typeof fetch
    });
    const quotaGate = new CjQuotaGate({
      redis,
      ipQpsLimit: 20,
      now: () => new Date("2026-06-29T00:00:00.000Z")
    });
    const usageLogger = new CjUsageLogger(db);
    const metadataSync = new CjMetadataSync({ db, apiClient, quotaGate, usageLogger });
    const productIndexer = new CjProductIndexer({
      db,
      apiClient,
      quotaGate,
      usageLogger,
      maxConcurrency: 1,
      countryMode: "warehouse",
      listV2Filters: {
        minSellPrice: 0.01,
        minWarehouseInventory: 1,
        verifiedWarehouse: "verified",
        productFlag: "trending",
        freeShippingOnly: false
      },
      defaultTimeStart: new Date("2020-01-01T00:00:00.000Z"),
      defaultTimeEnd: new Date("2026-06-29T00:00:00.000Z")
    });

    await metadataSync.syncCategories(account);
    await metadataSync.syncWarehouses(account);
    await productIndexer.run(account);
    await productIndexer.run(account);

    const products = await db.select().from(cjProductIndexes).where(eq(cjProductIndexes.accountId, account.id));
    expect(products).toHaveLength(1);
    expect(products[0]?.pid).toBe("pid-1");
    expect(products[0]?.countryCode).toBe("US");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

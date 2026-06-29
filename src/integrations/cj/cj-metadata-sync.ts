import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { cjCategories, cjWarehouses, type CjAccount } from "../../db/schema.js";
import { CjApiClient } from "./cj-api-client.js";
import { CJ_ENDPOINT_POINT_COST, CJ_ENDPOINTS } from "./constants.js";
import { CjQuotaGate } from "./cj-quota-gate.js";
import { CjSyncCursorStore } from "./cj-sync-cursor.js";
import { CjUsageLogger } from "./cj-usage-logger.js";
import type { CjCategoryLevel1, CjWarehouse } from "./types.js";

export class CjMetadataSync {
  private readonly cursorStore: CjSyncCursorStore;

  constructor(private readonly options: {
    db: Db;
    apiClient: CjApiClient;
    quotaGate: CjQuotaGate;
    usageLogger: CjUsageLogger;
  }) {
    this.cursorStore = new CjSyncCursorStore(options.db);
  }

  async syncCategories(account: CjAccount) {
    const cursor = await this.cursorStore.ensureNullSliceCursor(account.id, "cj.category.sync");
    await this.cursorStore.markRunning(cursor.id);
    const started = performance.now();

    try {
      await this.options.quotaGate.waitForTurn(account, CJ_ENDPOINTS.getCategory);
      const result = await this.options.apiClient.getCategory(account.id);
      await this.options.usageLogger.logSuccess(account.id, result);
      await this.upsertCategories(account.id, result.envelope.data);
      await this.cursorStore.complete(cursor.id, { requestId: result.envelope.requestId ?? undefined });
    } catch (error) {
      await this.options.usageLogger.logError({
        accountId: account.id,
        endpoint: CJ_ENDPOINTS.getCategory,
        method: "GET",
        pointsCost: CJ_ENDPOINT_POINT_COST[CJ_ENDPOINTS.getCategory],
        durationMs: Math.round(performance.now() - started),
        error
      });
      await this.cursorStore.fail(cursor.id, error);
      throw error;
    }
  }

  async syncWarehouses(account: CjAccount) {
    const cursor = await this.cursorStore.ensureNullSliceCursor(account.id, "cj.warehouse.sync");
    await this.cursorStore.markRunning(cursor.id);
    const started = performance.now();

    try {
      await this.options.quotaGate.waitForTurn(account, CJ_ENDPOINTS.globalWarehouseList);
      const result = await this.options.apiClient.getGlobalWarehouseList(account.id);
      await this.options.usageLogger.logSuccess(account.id, result);
      await this.upsertWarehouses(account.id, result.envelope.data);
      await this.cursorStore.complete(cursor.id, { requestId: result.envelope.requestId ?? undefined });
    } catch (error) {
      await this.options.usageLogger.logError({
        accountId: account.id,
        endpoint: CJ_ENDPOINTS.globalWarehouseList,
        method: "GET",
        pointsCost: CJ_ENDPOINT_POINT_COST[CJ_ENDPOINTS.globalWarehouseList],
        durationMs: Math.round(performance.now() - started),
        error
      });
      await this.cursorStore.fail(cursor.id, error);
      throw error;
    }
  }

  private async upsertCategories(accountId: string, categories: CjCategoryLevel1[]) {
    const rows = flattenCategories(accountId, categories);
    if (rows.length === 0) return;

    await this.options.db.insert(cjCategories).values(rows).onConflictDoUpdate({
      target: [cjCategories.accountId, cjCategories.categoryId],
      set: {
        parentCategoryId: sql`excluded.parent_category_id`,
        level: sql`excluded.level`,
        name: sql`excluded.name`,
        raw: sql`excluded.raw`,
        syncedAt: sql`excluded.synced_at`
      }
    });
  }

  private async upsertWarehouses(accountId: string, warehouses: CjWarehouse[]) {
    const rows = warehouses.flatMap((warehouse) => {
      const warehouseId = String(warehouse.id ?? warehouse.areaId ?? warehouse.countryCode ?? "");
      const countryCode = warehouse.countryCode;
      if (!warehouseId || !countryCode) return [];
      return [{
        accountId,
        warehouseId,
        areaId: typeof warehouse.areaId === "number" ? warehouse.areaId : null,
        countryCode,
        nameEn: warehouse.nameEn ?? null,
        areaEn: warehouse.areaEn ?? null,
        disabled: warehouse.disabled ?? false,
        raw: warehouse,
        syncedAt: new Date()
      }];
    });

    if (rows.length === 0) return;

    await this.options.db.insert(cjWarehouses).values(rows).onConflictDoUpdate({
      target: [cjWarehouses.accountId, cjWarehouses.warehouseId],
      set: {
        areaId: sql`excluded.area_id`,
        countryCode: sql`excluded.country_code`,
        nameEn: sql`excluded.name_en`,
        areaEn: sql`excluded.area_en`,
        disabled: sql`excluded.disabled`,
        raw: sql`excluded.raw`,
        syncedAt: sql`excluded.synced_at`
      }
    });
  }
}

function flattenCategories(accountId: string, categories: CjCategoryLevel1[]) {
  return categories.flatMap((first) => {
    const firstId = first.categoryFirstId ?? first.categoryFirstName;
    if (!firstId || !first.categoryFirstName) return [];
    const firstRow = {
      accountId,
      categoryId: firstId,
      parentCategoryId: null,
      level: 1,
      name: first.categoryFirstName,
      raw: first as Record<string, unknown>,
      syncedAt: new Date()
    };

    const secondRows = (first.categoryFirstList ?? []).flatMap((second) => {
      const secondId = second.categorySecondId ?? second.categorySecondName;
      if (!secondId || !second.categorySecondName) return [];
      const secondRow = {
        accountId,
        categoryId: secondId,
        parentCategoryId: firstId,
        level: 2,
        name: second.categorySecondName,
        raw: second as Record<string, unknown>,
        syncedAt: new Date()
      };

      const thirdRows = (second.categorySecondList ?? []).flatMap((third) => {
        const thirdId = third.categoryId ?? third.categoryThirdId ?? third.categoryName ?? third.categoryThirdName;
        const thirdName = third.categoryName ?? third.categoryThirdName;
        if (!thirdId || !thirdName) return [];
        return [{
          accountId,
          categoryId: thirdId,
          parentCategoryId: secondId,
          level: 3,
          name: thirdName,
          raw: third as Record<string, unknown>,
          syncedAt: new Date()
        }];
      });

      return [secondRow, ...thirdRows];
    });

    return [firstRow, ...secondRows];
  });
}

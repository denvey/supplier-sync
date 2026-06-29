import { BasicCrawler, log, LogLevel } from "crawlee";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { cjCategories, cjProductIndexes, cjSyncCursors, cjWarehouses, type CjAccount, type CjSyncCursor } from "../../db/schema.js";
import { CjApiClient, CjApiError } from "./cj-api-client.js";
import { CJ_ENDPOINT_POINT_COST, CJ_ENDPOINTS, CJ_GLOBAL_COUNTRY_CODE, CJ_LIST_V2_MAX_PAGE, CJ_LIST_V2_MAX_TOTAL_RECORDS, CJ_LIST_V2_PAGE_SIZE, CJ_LIST_V2_SPLIT_THRESHOLD } from "./constants.js";
import { CjQuotaGate } from "./cj-quota-gate.js";
import { CjSyncCursorStore, type ProductIndexSlice } from "./cj-sync-cursor.js";
import { CjUsageLogger } from "./cj-usage-logger.js";
import { sanitizePostgresJson, sanitizePostgresText } from "./postgres-sanitize.js";
import type { CjListV2Params, CjProductListV2Product } from "./types.js";

export interface ProductIndexerOptions {
  db: Db;
  apiClient: CjApiClient;
  quotaGate: CjQuotaGate;
  usageLogger: CjUsageLogger;
  maxConcurrency: number;
  countryMode: "none" | "warehouse";
  listV2Filters: ProductIndexListV2Filters;
  defaultTimeStart: Date;
  defaultTimeEnd: Date;
  logger?: ProductIndexerLogger | undefined;
}

export interface ProductIndexListV2Filters {
  minSellPrice?: number | undefined;
  maxSellPrice?: number | undefined;
  minWarehouseInventory?: number | undefined;
  maxWarehouseInventory?: number | undefined;
  verifiedWarehouse: "all" | "verified" | "unverified";
  productFlag: "all" | "trending" | "latest" | "video" | "unsalable";
  freeShippingOnly: boolean;
}

export interface ProductIndexerLogger {
  info(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export class CjProductIndexer {
  private readonly cursorStore: CjSyncCursorStore;
  private readonly logger: ProductIndexerLogger;

  constructor(private readonly options: ProductIndexerOptions) {
    this.cursorStore = new CjSyncCursorStore(options.db);
    this.logger = options.logger ?? silentLogger;
    log.setLevel(LogLevel.INFO);
  }

  async seedAllProductIndexCursors(account: CjAccount) {
    const existingCursorCount = await this.cursorStore.countProductIndexCursors(account.id);
    if (existingCursorCount > 0) {
      this.info(`[cj:sync:index] using existing cursors count=${existingCursorCount}; skip seed`);
      return;
    }

    this.info(`[cj:sync:index] ensuring cursors account=${account.id} mode=${this.options.countryMode} window=${formatDate(this.options.defaultTimeStart)}..${formatDate(this.options.defaultTimeEnd)}`);
    const categories = await this.options.db
      .select({ categoryId: cjCategories.categoryId })
      .from(cjCategories)
      .where(and(eq(cjCategories.accountId, account.id), eq(cjCategories.level, 3)));

    if (categories.length === 0) {
      throw new Error("No CJ level 3 categories found. Run pnpm cj:sync:categories first.");
    }

    if (this.options.countryMode === "none") {
      await this.createProductIndexCursorSlices(categories.map((category) => ({
        accountId: account.id,
        categoryId: category.categoryId,
        countryCode: CJ_GLOBAL_COUNTRY_CODE,
        timeStart: this.options.defaultTimeStart,
        timeEnd: this.options.defaultTimeEnd
      })));
      this.info(`[cj:sync:index] cursors ensured categories=${categories.length} countries=1 totalSlices=${categories.length}`);
      return;
    }

    const warehouses = await this.options.db
      .select({ countryCode: cjWarehouses.countryCode })
      .from(cjWarehouses)
      .where(and(eq(cjWarehouses.accountId, account.id), eq(cjWarehouses.disabled, false)));

    if (warehouses.length === 0) {
      throw new Error("No CJ warehouses found. Run pnpm cj:sync:warehouses first or set CJ_SYNC_COUNTRY_MODE=none.");
    }

    const uniqueCountryCount = new Set(warehouses.map((warehouse) => warehouse.countryCode)).size;
    await this.createProductIndexCursorSlices(categories.flatMap((category) => (
      warehouses.map((warehouse) => ({
          accountId: account.id,
          categoryId: category.categoryId,
          countryCode: warehouse.countryCode,
          timeStart: this.options.defaultTimeStart,
          timeEnd: this.options.defaultTimeEnd
      }))
    )));
    this.info(`[cj:sync:index] cursors ensured categories=${categories.length} warehouses=${warehouses.length} countries=${uniqueCountryCount} totalSlices=${categories.length * warehouses.length}`);
  }

  async run(account: CjAccount) {
    const effectiveQpsLimit = await this.options.quotaGate.getEffectiveAccountQpsLimit(account);
    const maxConcurrency = Math.max(1, Math.min(this.options.maxConcurrency, effectiveQpsLimit));
    this.info(`[cj:sync:index] start account=${account.id} quota=${this.quotaMode(account)} configuredQpsLimit=${account.qpsLimit} effectiveQpsLimit=${effectiveQpsLimit} maxConcurrency=${maxConcurrency} configuredMaxConcurrency=${this.options.maxConcurrency} pointsEffectiveAt=${formatDate(account.pointsEffectiveAt)}`);
    await this.seedAllProductIndexCursors(account);
    const crawler = new BasicCrawler({
      minConcurrency: 1,
      maxConcurrency,
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs: 120,
      requestHandler: async ({ request }) => {
        const cursorId = String(request.userData["cursorId"]);
        await this.processCursor(account, cursorId);
      },
      failedRequestHandler: async ({ request, error }) => {
        this.error(`[cj:sync:index] cursor failed after retries id=${String(request.userData["cursorId"])} error=${formatError(error)}`);
        await this.cursorStore.fail(String(request.userData["cursorId"]), error);
      }
    });

    const cursors = await this.options.db.select().from(cjSyncCursors).where(and(
      eq(cjSyncCursors.accountId, account.id),
      eq(cjSyncCursors.taskType, "cj.product.index"),
      ne(cjSyncCursors.status, "completed"),
      ne(cjSyncCursors.status, "split")
    ));

    this.info(`[cj:sync:index] queued pendingCursors=${cursors.length}`);
    if (cursors.length === 0) {
      this.info("[cj:sync:index] complete no pending cursors");
      return;
    }

    await crawler.addRequests(cursors.map((cursor) => ({
      url: `https://supplier-sync.local/cj/product-index/${cursor.id}`,
      uniqueKey: `cj.product.index:${cursor.id}:${cursor.page}`,
      userData: { cursorId: cursor.id }
    })));

    await crawler.run();
    this.info(`[cj:sync:index] complete queuedCursors=${cursors.length}`);
  }

  async processCursor(account: CjAccount, cursorId: string) {
    const [cursor] = await this.options.db.select().from(cjSyncCursors).where(eq(cjSyncCursors.id, cursorId)).limit(1);
    if (!cursor) throw new Error(`Cursor not found: ${cursorId}`);
    if (cursor.status === "completed" || cursor.status === "split") {
      this.info(`[cj:sync:index] cursor skip id=${cursor.id} status=${cursor.status}`);
      return;
    }

    this.assertProductIndexCursor(cursor);
    this.info(`[cj:sync:index] cursor start id=${cursor.id} category=${cursor.categoryId} country=${cursor.countryCode} page=${cursor.page} window=${formatDate(cursor.timeStart)}..${formatDate(cursor.timeEnd)}`);
    await this.cursorStore.markRunning(cursor.id);

    try {
      let page = cursor.page;
      while (page <= CJ_LIST_V2_MAX_PAGE) {
        this.info(`[cj:sync:index] page waiting cursor=${cursor.id} category=${cursor.categoryId} country=${cursor.countryCode} page=${page}`);
        await this.options.quotaGate.waitForTurn(account, CJ_ENDPOINTS.productListV2);
        const started = performance.now();
        let result;
        try {
          const params: CjListV2Params = {
            categoryId: cursor.categoryId,
            timeStart: cursor.timeStart.getTime(),
            timeEnd: cursor.timeEnd.getTime(),
            page,
            size: CJ_LIST_V2_PAGE_SIZE,
            sort: "asc",
            orderBy: 3,
            features: ["enable_category"]
          };
          if (cursor.countryCode !== CJ_GLOBAL_COUNTRY_CODE) {
            params.countryCode = cursor.countryCode;
          }
          this.applyListV2Filters(params);
          result = await this.options.apiClient.listProductsV2(account.id, params);
        } catch (error) {
          await this.logUsageError({
            accountId: account.id,
            endpoint: CJ_ENDPOINTS.productListV2,
            method: "GET",
            pointsCost: CJ_ENDPOINT_POINT_COST[CJ_ENDPOINTS.productListV2],
            durationMs: Math.round(performance.now() - started),
            error
          });
          throw error;
        }
        await this.logUsageSuccess(account.id, result);
        await this.options.quotaGate.recordSuccess(account);

        const data = result.envelope.data;
        const totalRecords = data.totalRecords ?? 0;
        const totalPages = data.totalPages ?? 0;
        const products = flattenProducts(data.content);
        this.info(`[cj:sync:index] page done cursor=${cursor.id} category=${cursor.categoryId} country=${cursor.countryCode} page=${page}/${totalPages || 0} products=${products.length} totalRecords=${totalRecords} requestId=${result.envelope.requestId ?? "-"}${this.pointsLogSegment(account, result.envelope.pointsInfo)}`);

        if (this.shouldSplit(cursor, totalRecords, totalPages)) {
          this.warn(`[cj:sync:index] cursor split id=${cursor.id} category=${cursor.categoryId} country=${cursor.countryCode} totalRecords=${totalRecords} totalPages=${totalPages}`);
          await this.splitCursor(cursor);
          return;
        }

        await this.upsertProducts(account.id, cursor.countryCode, result.envelope.requestId ?? undefined, products);

        if (page >= totalPages || totalPages === 0) {
          await this.cursorStore.complete(cursor.id, {
            totalRecords,
            totalPages,
            requestId: result.envelope.requestId ?? undefined
          });
          this.info(`[cj:sync:index] cursor complete id=${cursor.id} category=${cursor.categoryId} country=${cursor.countryCode} totalRecords=${totalRecords} totalPages=${totalPages}`);
          return;
        }

        page += 1;
        await this.cursorStore.advance(cursor.id, {
          nextPage: page,
          totalRecords,
          totalPages,
          requestId: result.envelope.requestId ?? undefined
        });
      }

      this.warn(`[cj:sync:index] cursor reached max page and will split id=${cursor.id} maxPage=${CJ_LIST_V2_MAX_PAGE}`);
      await this.splitCursor(cursor);
    } catch (error) {
      if (error instanceof CjApiError && error.statusCode === 429) {
        if (!isPointsExhaustedError(error)) {
          const rateLimit = await this.options.quotaGate.recordRateLimited(account);
          this.warn(`[cj:sync:index] cursor rate limited id=${cursor.id} nextQpsLimit=${rateLimit.nextLimit} cooldownMs=${rateLimit.cooldownMs} error=${formatError(error)}`);
          await this.cursorStore.fail(cursor.id, error);
          throw error;
        }
        this.warn(`[cj:sync:index] stopped because CJ points are exhausted cursor=${cursor.id} error=${formatError(error)}`);
        await this.cursorStore.fail(cursor.id, error);
        return;
      }
      await this.cursorStore.fail(cursor.id, error);
      throw error;
    }
  }

  private async upsertProducts(accountId: string, countryCode: string, requestId: string | undefined, products: CjProductListV2Product[]) {
    if (products.length === 0) return;

    await this.options.db.insert(cjProductIndexes).values(products.flatMap((product) => {
      const pid = product.id;
      if (!pid) return [];
      const sellPrice = priceRangeOrNull(product.sellPrice);
      const nowPrice = priceRangeOrNull(product.nowPrice);
      return [{
        accountId,
        pid,
        countryCode,
        spu: stringOrNull(product.spu),
        sku: stringOrNull(product.sku),
        title: stringOrNull(product.nameEn),
        mainImage: stringOrNull(product.bigImage),
        categoryId: stringOrNull(product.categoryId),
        categoryName: stringOrNull(product.threeCategoryName),
        sellPrice: sellPrice?.min ?? null,
        sellPriceMax: sellPrice?.max ?? null,
        nowPrice: nowPrice?.min ?? null,
        nowPriceMax: nowPrice?.max ?? null,
        listedNum: numberOrNull(product.listedNum),
        warehouseInventoryNum: numberOrNull(product.warehouseInventoryNum),
        totalVerifiedInventory: numberOrNull(product.totalVerifiedInventory),
        totalUnverifiedInventory: numberOrNull(product.totalUnVerifiedInventory),
        createAt: parseCjCreateAt(product.createAt),
        saleStatus: product.saleStatus === undefined || product.saleStatus === null ? null : String(product.saleStatus),
        raw: sanitizePostgresJson(product) as Record<string, unknown>,
        sourceRequestId: requestId,
        syncedAt: new Date(),
        updatedAt: new Date()
      }];
    })).onConflictDoUpdate({
      target: [cjProductIndexes.accountId, cjProductIndexes.pid, cjProductIndexes.countryCode],
      set: {
        spu: sql`excluded.spu`,
        sku: sql`excluded.sku`,
        title: sql`excluded.title`,
        mainImage: sql`excluded.main_image`,
        categoryId: sql`excluded.category_id`,
        categoryName: sql`excluded.category_name`,
        sellPrice: sql`excluded.sell_price`,
        sellPriceMax: sql`excluded.sell_price_max`,
        nowPrice: sql`excluded.now_price`,
        nowPriceMax: sql`excluded.now_price_max`,
        listedNum: sql`excluded.listed_num`,
        warehouseInventoryNum: sql`excluded.warehouse_inventory_num`,
        totalVerifiedInventory: sql`excluded.total_verified_inventory`,
        totalUnverifiedInventory: sql`excluded.total_unverified_inventory`,
        createAt: sql`excluded.create_at`,
        saleStatus: sql`excluded.sale_status`,
        raw: sql`excluded.raw`,
        sourceRequestId: sql`excluded.source_request_id`,
        syncedAt: sql`excluded.synced_at`,
        updatedAt: sql`excluded.updated_at`
      }
    });
  }

  private shouldSplit(cursor: CjSyncCursor, totalRecords: number, totalPages: number) {
    if (!cursor.timeStart || !cursor.timeEnd) return false;
    if (totalRecords >= CJ_LIST_V2_MAX_TOTAL_RECORDS) return true;
    if (totalRecords >= CJ_LIST_V2_SPLIT_THRESHOLD) return true;
    return totalPages > CJ_LIST_V2_MAX_PAGE;
  }

  private async splitCursor(cursor: CjSyncCursor) {
    this.assertProductIndexCursor(cursor);
    const windows = this.cursorStore.splitTimeRange(cursor.timeStart, cursor.timeEnd);
    for (const window of windows) {
      const slice: ProductIndexSlice = {
        accountId: cursor.accountId,
        categoryId: cursor.categoryId,
        countryCode: cursor.countryCode,
        timeStart: window.timeStart,
        timeEnd: window.timeEnd
      };
      await this.cursorStore.getOrCreateProductIndexCursor(slice);
    }
    await this.cursorStore.markSplit(cursor.id);
  }

  private assertProductIndexCursor(cursor: CjSyncCursor): asserts cursor is CjSyncCursor & {
    categoryId: string;
    countryCode: string;
    timeStart: Date;
    timeEnd: Date;
  } {
    if (!cursor.categoryId || !cursor.countryCode || !cursor.timeStart || !cursor.timeEnd) {
      throw new Error(`Product index cursor ${cursor.id} is missing slice fields`);
    }
  }

  private info(message: string) {
    this.logger.info(message);
  }

  private warn(message: string) {
    (this.logger.warn ?? this.logger.info).call(this.logger, message);
  }

  private error(message: string) {
    (this.logger.error ?? this.logger.info).call(this.logger, message);
  }

  private async createProductIndexCursorSlices(slices: ProductIndexSlice[]) {
    const batchSize = 500;
    for (let index = 0; index < slices.length; index += batchSize) {
      const batch = slices.slice(index, index + batchSize);
      await this.cursorStore.createProductIndexCursors(batch);
      this.info(`[cj:sync:index] cursor seed progress ${Math.min(index + batch.length, slices.length)}/${slices.length}`);
    }
  }

  private async logUsageSuccess(accountId: string, result: Awaited<ReturnType<CjApiClient["listProductsV2"]>>) {
    try {
      await this.options.usageLogger.logSuccess(accountId, result);
    } catch (error) {
      this.warn(`[cj:sync:index] usage log success failed requestId=${result.envelope.requestId ?? "-"} error=${formatError(error)}`);
    }
  }

  private async logUsageError(input: {
    accountId: string;
    endpoint: typeof CJ_ENDPOINTS.productListV2;
    method: "GET";
    pointsCost: number;
    durationMs: number;
    error: unknown;
  }) {
    try {
      await this.options.usageLogger.logError(input);
    } catch (error) {
      this.warn(`[cj:sync:index] usage log error failed error=${formatError(error)}`);
    }
  }

  private quotaMode(account: CjAccount) {
    return this.options.quotaGate.isPointsMode(account) ? "points" : "qps";
  }

  private pointsLogSegment(account: CjAccount, pointsInfo: { remaining?: number | undefined } | undefined) {
    if (this.quotaMode(account) !== "points" || pointsInfo?.remaining === undefined) return "";
    return ` pointsRemaining=${pointsInfo.remaining}`;
  }

  private applyListV2Filters(params: CjListV2Params) {
    const filters = this.options.listV2Filters;
    if (filters.minSellPrice !== undefined) params.startSellPrice = filters.minSellPrice;
    if (filters.maxSellPrice !== undefined) params.endSellPrice = filters.maxSellPrice;
    if (filters.minWarehouseInventory !== undefined) params.startWarehouseInventory = filters.minWarehouseInventory;
    if (filters.maxWarehouseInventory !== undefined) params.endWarehouseInventory = filters.maxWarehouseInventory;
    if (filters.verifiedWarehouse === "verified") params.verifiedWarehouse = 1;
    if (filters.verifiedWarehouse === "unverified") params.verifiedWarehouse = 2;
    if (filters.productFlag !== "all") params.productFlag = productFlagValue(filters.productFlag);
    if (filters.freeShippingOnly) params.addMarkStatus = 1;
  }
}

function productFlagValue(flag: Exclude<ProductIndexListV2Filters["productFlag"], "all">) {
  return {
    trending: 0,
    latest: 1,
    video: 2,
    unsalable: 3
  }[flag] as 0 | 1 | 2 | 3;
}

const silentLogger: ProductIndexerLogger = {
  info: () => undefined
};

function flattenProducts(content: { productList?: CjProductListV2Product[] }[] | undefined) {
  return (content ?? []).flatMap((item) => item.productList ?? []);
}

function stringOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const sanitized = sanitizePostgresText(value);
  return sanitized.length > 0 ? sanitized : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function priceRangeOrNull(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const numbers = typeof value === "string" ? numbersInString(value) : [Number(value)];
  const finite = numbers.filter((number) => Number.isFinite(number));
  if (finite.length === 0) return null;
  const min = finite[0]!;
  const max = finite.at(-1) ?? min;
  return {
    min: min.toFixed(2),
    max: max.toFixed(2)
  };
}

function numbersInString(value: string) {
  return [...value.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function parseCjCreateAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function isPointsExhaustedError(error: CjApiError) {
  const remaining = error.pointsInfo?.remaining;
  return remaining === 0 || error.message.toLowerCase().includes("insufficient api points");
}

function formatDate(date: Date) {
  return date.toISOString();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

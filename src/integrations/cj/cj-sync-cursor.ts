import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { cjSyncCursors, type CjSyncCursor } from "../../db/schema.js";
import { formatPostgresErrorMessage } from "./postgres-sanitize.js";

export interface ProductIndexSlice {
  accountId: string;
  categoryId: string;
  countryCode: string;
  timeStart: Date;
  timeEnd: Date;
}

export class CjSyncCursorStore {
  constructor(private readonly db: Db) {}

  async createProductIndexCursors(slices: ProductIndexSlice[]) {
    if (slices.length === 0) return;

    await this.db.insert(cjSyncCursors).values(slices.map((slice) => ({
      accountId: slice.accountId,
      taskType: "cj.product.index" as const,
      categoryId: slice.categoryId,
      countryCode: slice.countryCode,
      timeStart: slice.timeStart,
      timeEnd: slice.timeEnd,
      page: 1,
      pageSize: 100,
      status: "pending" as const
    }))).onConflictDoNothing();
  }

  async countProductIndexCursors(accountId: string) {
    const [row] = await this.db.select({
      count: sql<number>`count(*)::int`
    }).from(cjSyncCursors).where(and(
      eq(cjSyncCursors.accountId, accountId),
      eq(cjSyncCursors.taskType, "cj.product.index")
    ));

    return row?.count ?? 0;
  }

  async getOrCreateProductIndexCursor(slice: ProductIndexSlice) {
    const existing = await this.findProductIndexCursor(slice);
    if (existing) return existing;

    const [created] = await this.db.insert(cjSyncCursors).values({
      accountId: slice.accountId,
      taskType: "cj.product.index",
      categoryId: slice.categoryId,
      countryCode: slice.countryCode,
      timeStart: slice.timeStart,
      timeEnd: slice.timeEnd,
      page: 1,
      pageSize: 100,
      status: "pending"
    }).returning();

    if (!created) {
      throw new Error("Failed to create product index cursor");
    }

    return created;
  }

  async markRunning(cursorId: string) {
    await this.db.update(cjSyncCursors).set({
      status: "running",
      startedAt: new Date(),
      errorMessage: null,
      updatedAt: new Date()
    }).where(eq(cjSyncCursors.id, cursorId));
  }

  async advance(cursorId: string, input: {
    nextPage: number;
    totalRecords?: number | undefined;
    totalPages?: number | undefined;
    requestId?: string | undefined;
  }) {
    await this.db.update(cjSyncCursors).set({
      page: input.nextPage,
      totalRecords: input.totalRecords,
      totalPages: input.totalPages,
      lastRequestId: input.requestId,
      updatedAt: new Date()
    }).where(eq(cjSyncCursors.id, cursorId));
  }

  async complete(cursorId: string, input?: {
    totalRecords?: number | undefined;
    totalPages?: number | undefined;
    requestId?: string | undefined;
  }) {
    await this.db.update(cjSyncCursors).set({
      status: "completed",
      totalRecords: input?.totalRecords,
      totalPages: input?.totalPages,
      lastRequestId: input?.requestId,
      completedAt: new Date(),
      updatedAt: new Date()
    }).where(eq(cjSyncCursors.id, cursorId));
  }

  async fail(cursorId: string, error: unknown) {
    await this.db.update(cjSyncCursors).set({
      status: "failed",
      errorMessage: formatPostgresErrorMessage(error),
      updatedAt: new Date()
    }).where(eq(cjSyncCursors.id, cursorId));
  }

  async markSplit(cursorId: string) {
    await this.db.update(cjSyncCursors).set({
      status: "split",
      updatedAt: new Date()
    }).where(eq(cjSyncCursors.id, cursorId));
  }

  splitTimeRange(timeStart: Date, timeEnd: Date) {
    const start = timeStart.getTime();
    const end = timeEnd.getTime();
    if (end - start <= 1000) {
      throw new Error("Cannot split product index window smaller than one second");
    }

    const mid = new Date(Math.floor((start + end) / 2));
    return [
      { timeStart, timeEnd: mid },
      { timeStart: new Date(mid.getTime() + 1), timeEnd }
    ];
  }

  private async findProductIndexCursor(slice: ProductIndexSlice): Promise<CjSyncCursor | undefined> {
    const filters = [
      eq(cjSyncCursors.accountId, slice.accountId),
      eq(cjSyncCursors.taskType, "cj.product.index"),
      eq(cjSyncCursors.categoryId, slice.categoryId),
      eq(cjSyncCursors.countryCode, slice.countryCode),
      eq(cjSyncCursors.timeStart, slice.timeStart),
      eq(cjSyncCursors.timeEnd, slice.timeEnd)
    ];

    const [existing] = await this.db.select().from(cjSyncCursors).where(and(...filters)).limit(1);
    return existing;
  }

  async pendingProductIndexCursors(accountId: string) {
    return this.db.select().from(cjSyncCursors).where(and(
      eq(cjSyncCursors.accountId, accountId),
      eq(cjSyncCursors.taskType, "cj.product.index"),
      eq(cjSyncCursors.status, "pending")
    ));
  }

  async ensureNullSliceCursor(accountId: string, taskType: "cj.category.sync" | "cj.warehouse.sync") {
    const [existing] = await this.db.select().from(cjSyncCursors).where(and(
      eq(cjSyncCursors.accountId, accountId),
      eq(cjSyncCursors.taskType, taskType),
      isNull(cjSyncCursors.categoryId),
      isNull(cjSyncCursors.countryCode),
      isNull(cjSyncCursors.timeStart),
      isNull(cjSyncCursors.timeEnd)
    )).limit(1);

    if (existing) return existing;

    const [created] = await this.db.insert(cjSyncCursors).values({
      accountId,
      taskType,
      status: "pending"
    }).returning();

    if (!created) throw new Error(`Failed to create ${taskType} cursor`);
    return created;
  }
}

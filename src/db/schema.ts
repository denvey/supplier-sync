import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const syncTaskTypeEnum = pgEnum("sync_task_type", [
  "cj.category.sync",
  "cj.warehouse.sync",
  "cj.product.index",
  "cj.product.detail",
  "cj.variant.sync",
  "cj.inventory.refresh",
  "cj.webhook.event"
]);

export const syncTaskStatusEnum = pgEnum("sync_task_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "paused"
]);

export const cursorStatusEnum = pgEnum("cursor_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "split"
]);

export const cjAccounts = pgTable("cj_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
  qpsLimit: integer("qps_limit").notNull().default(1),
  dailyPointBudget: integer("daily_point_budget").notNull().default(50000),
  pointsEffectiveAt: timestamp("points_effective_at", { withTimezone: true }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("cj_accounts_name_uidx").on(table.name),
  index("cj_accounts_active_idx").on(table.isActive)
]);

export const cjCategories = pgTable("cj_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => cjAccounts.id),
  categoryId: text("category_id").notNull(),
  parentCategoryId: text("parent_category_id"),
  level: integer("level").notNull(),
  name: text("name").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("cj_categories_account_category_uidx").on(table.accountId, table.categoryId),
  index("cj_categories_parent_idx").on(table.parentCategoryId)
]);

export const cjWarehouses = pgTable("cj_warehouses", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => cjAccounts.id),
  warehouseId: text("warehouse_id").notNull(),
  areaId: integer("area_id"),
  countryCode: text("country_code").notNull(),
  nameEn: text("name_en"),
  areaEn: text("area_en"),
  disabled: boolean("disabled").notNull().default(false),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("cj_warehouses_account_warehouse_uidx").on(table.accountId, table.warehouseId),
  index("cj_warehouses_country_idx").on(table.countryCode)
]);

export const cjProductIndexes = pgTable("cj_product_indexes", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => cjAccounts.id),
  pid: text("pid").notNull(),
  countryCode: text("country_code").notNull(),
  spu: text("spu"),
  sku: text("sku"),
  title: text("title"),
  mainImage: text("main_image"),
  categoryId: text("category_id"),
  categoryName: text("category_name"),
  sellPrice: numeric("sell_price", { precision: 12, scale: 2 }),
  sellPriceMax: numeric("sell_price_max", { precision: 12, scale: 2 }),
  nowPrice: numeric("now_price", { precision: 12, scale: 2 }),
  nowPriceMax: numeric("now_price_max", { precision: 12, scale: 2 }),
  listedNum: integer("listed_num"),
  warehouseInventoryNum: integer("warehouse_inventory_num"),
  totalVerifiedInventory: integer("total_verified_inventory"),
  totalUnverifiedInventory: integer("total_unverified_inventory"),
  createAt: timestamp("create_at", { withTimezone: true }),
  saleStatus: text("sale_status"),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  sourceRequestId: text("source_request_id"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("cj_product_indexes_account_pid_country_uidx").on(table.accountId, table.pid, table.countryCode),
  index("cj_product_indexes_category_idx").on(table.categoryId),
  index("cj_product_indexes_create_at_idx").on(table.createAt)
]);

export const cjSyncCursors = pgTable("cj_sync_cursors", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => cjAccounts.id),
  taskType: syncTaskTypeEnum("task_type").notNull(),
  categoryId: text("category_id"),
  countryCode: text("country_code"),
  timeStart: timestamp("time_start", { withTimezone: true }),
  timeEnd: timestamp("time_end", { withTimezone: true }),
  page: integer("page").notNull().default(1),
  pageSize: integer("page_size").notNull().default(100),
  totalRecords: integer("total_records"),
  totalPages: integer("total_pages"),
  status: cursorStatusEnum("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  lastRequestId: text("last_request_id"),
  rawState: jsonb("raw_state").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex("cj_sync_cursors_slice_uidx").on(
    table.accountId,
    table.taskType,
    table.categoryId,
    table.countryCode,
    table.timeStart,
    table.timeEnd
  ),
  uniqueIndex("cj_sync_cursors_metadata_uidx")
    .on(table.accountId, table.taskType)
    .where(sql`category_id is null and country_code is null and time_start is null and time_end is null`),
  index("cj_sync_cursors_status_idx").on(table.status)
]);

export const cjApiUsageLogs = pgTable("cj_api_usage_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => cjAccounts.id),
  endpoint: text("endpoint").notNull(),
  method: text("method").notNull(),
  statusCode: integer("status_code"),
  cjCode: integer("cj_code"),
  cjResult: boolean("cj_result"),
  message: text("message"),
  requestId: text("request_id"),
  pointsCost: integer("points_cost").notNull().default(0),
  pointsUsedToday: integer("points_used_today"),
  pointsRemaining: integer("points_remaining"),
  pointsTotal: integer("points_total"),
  durationMs: integer("duration_ms").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("cj_api_usage_logs_account_created_idx").on(table.accountId, table.createdAt),
  index("cj_api_usage_logs_endpoint_idx").on(table.endpoint),
  index("cj_api_usage_logs_request_id_idx").on(table.requestId)
]);

export const syncTasks = pgTable("sync_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").references(() => cjAccounts.id),
  type: syncTaskTypeEnum("type").notNull(),
  status: syncTaskStatusEnum("status").notNull().default("pending"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("sync_tasks_ready_idx").on(table.status, table.runAfter),
  index("sync_tasks_account_idx").on(table.accountId)
]);

export type CjAccount = typeof cjAccounts.$inferSelect;
export type NewCjAccount = typeof cjAccounts.$inferInsert;
export type CjSyncCursor = typeof cjSyncCursors.$inferSelect;
export type NewCjSyncCursor = typeof cjSyncCursors.$inferInsert;

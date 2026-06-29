CREATE TYPE "public"."cursor_status" AS ENUM('pending', 'running', 'completed', 'failed', 'split');--> statement-breakpoint
CREATE TYPE "public"."sync_task_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'paused');--> statement-breakpoint
CREATE TYPE "public"."sync_task_type" AS ENUM('cj.category.sync', 'cj.warehouse.sync', 'cj.product.index', 'cj.product.detail', 'cj.variant.sync', 'cj.inventory.refresh', 'cj.webhook.event');--> statement-breakpoint
CREATE TABLE "cj_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"registered_at" timestamp with time zone NOT NULL,
	"qps_limit" integer DEFAULT 1 NOT NULL,
	"daily_point_budget" integer DEFAULT 50000 NOT NULL,
	"points_effective_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_api_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer,
	"cj_code" integer,
	"cj_result" boolean,
	"message" text,
	"request_id" text,
	"points_cost" integer DEFAULT 0 NOT NULL,
	"points_used_today" integer,
	"points_remaining" integer,
	"points_total" integer,
	"duration_ms" integer NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"parent_category_id" text,
	"level" integer NOT NULL,
	"name" text NOT NULL,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_product_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"pid" text NOT NULL,
	"country_code" text NOT NULL,
	"spu" text,
	"sku" text,
	"title" text,
	"main_image" text,
	"category_id" text,
	"category_name" text,
	"sell_price" numeric(12, 2),
	"now_price" numeric(12, 2),
	"listed_num" integer,
	"warehouse_inventory_num" integer,
	"total_verified_inventory" integer,
	"total_unverified_inventory" integer,
	"create_at" timestamp with time zone,
	"sale_status" text,
	"raw" jsonb NOT NULL,
	"source_request_id" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"task_type" "sync_task_type" NOT NULL,
	"category_id" text,
	"country_code" text,
	"time_start" timestamp with time zone,
	"time_end" timestamp with time zone,
	"page" integer DEFAULT 1 NOT NULL,
	"page_size" integer DEFAULT 100 NOT NULL,
	"total_records" integer,
	"total_pages" integer,
	"status" "cursor_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"last_request_id" text,
	"raw_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cj_warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"warehouse_id" text NOT NULL,
	"area_id" integer,
	"country_code" text NOT NULL,
	"name_en" text,
	"area_en" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"type" "sync_task_type" NOT NULL,
	"status" "sync_task_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cj_api_usage_logs" ADD CONSTRAINT "cj_api_usage_logs_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cj_categories" ADD CONSTRAINT "cj_categories_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cj_product_indexes" ADD CONSTRAINT "cj_product_indexes_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cj_sync_cursors" ADD CONSTRAINT "cj_sync_cursors_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cj_warehouses" ADD CONSTRAINT "cj_warehouses_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_account_id_cj_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cj_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cj_accounts_name_uidx" ON "cj_accounts" USING btree ("name");--> statement-breakpoint
CREATE INDEX "cj_accounts_active_idx" ON "cj_accounts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "cj_api_usage_logs_account_created_idx" ON "cj_api_usage_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "cj_api_usage_logs_endpoint_idx" ON "cj_api_usage_logs" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "cj_api_usage_logs_request_id_idx" ON "cj_api_usage_logs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cj_categories_account_category_uidx" ON "cj_categories" USING btree ("account_id","category_id");--> statement-breakpoint
CREATE INDEX "cj_categories_parent_idx" ON "cj_categories" USING btree ("parent_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cj_product_indexes_account_pid_country_uidx" ON "cj_product_indexes" USING btree ("account_id","pid","country_code");--> statement-breakpoint
CREATE INDEX "cj_product_indexes_category_idx" ON "cj_product_indexes" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "cj_product_indexes_create_at_idx" ON "cj_product_indexes" USING btree ("create_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cj_sync_cursors_slice_uidx" ON "cj_sync_cursors" USING btree ("account_id","task_type","category_id","country_code","time_start","time_end");--> statement-breakpoint
CREATE UNIQUE INDEX "cj_sync_cursors_metadata_uidx" ON "cj_sync_cursors" USING btree ("account_id","task_type") WHERE category_id is null and country_code is null and time_start is null and time_end is null;--> statement-breakpoint
CREATE INDEX "cj_sync_cursors_status_idx" ON "cj_sync_cursors" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "cj_warehouses_account_warehouse_uidx" ON "cj_warehouses" USING btree ("account_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "cj_warehouses_country_idx" ON "cj_warehouses" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "sync_tasks_ready_idx" ON "sync_tasks" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "sync_tasks_account_idx" ON "sync_tasks" USING btree ("account_id");
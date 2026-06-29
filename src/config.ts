import "dotenv/config";
import { z } from "zod";

const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalEnvString = z.preprocess(emptyStringToUndefined, z.string().optional());
const optionalEnvDate = z.preprocess(emptyStringToUndefined, z.coerce.date().optional());
const optionalEnvNumber = z.preprocess(emptyStringToUndefined, z.coerce.number().positive().optional());
const optionalEnvBoolean = z.preprocess((value) => {
  if (value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean().optional());

const envSchema = z.object({
  DATABASE_URL: z.string().url().default("postgres://supplier_sync:supplier_sync@localhost:5432/supplier_sync"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  CJ_API_BASE_URL: z.string().url().default("https://developers.cjdropshipping.com/api2.0/v1"),
  CJ_ACCOUNT_ID: optionalEnvString,
  CJ_ACCOUNT_NAME: z.string().default("default"),
  CJ_API_KEY: optionalEnvString,
  CJ_ACCESS_TOKEN: optionalEnvString,
  CJ_REFRESH_TOKEN: optionalEnvString,
  CJ_REGISTERED_AT: z.coerce.date().default(new Date("2026-05-31T00:00:00.000Z")),
  CJ_ACCOUNT_QPS_LIMIT: z.coerce.number().int().positive().default(1),
  CJ_SYNC_COUNTRY_MODE: z.enum(["none", "warehouse"]).default("none"),
  CJ_SYNC_MIN_SELL_PRICE: optionalEnvNumber.default(0.01),
  CJ_SYNC_MAX_SELL_PRICE: optionalEnvNumber,
  CJ_SYNC_MIN_WAREHOUSE_INVENTORY: optionalEnvNumber.default(1),
  CJ_SYNC_MAX_WAREHOUSE_INVENTORY: optionalEnvNumber,
  CJ_SYNC_VERIFIED_WAREHOUSE: z.preprocess(emptyStringToUndefined, z.enum(["all", "verified", "unverified"]).default("verified")),
  CJ_SYNC_PRODUCT_FLAG: z.preprocess(emptyStringToUndefined, z.enum(["all", "trending", "latest", "video", "unsalable"]).default("trending")),
  CJ_SYNC_FREE_SHIPPING_ONLY: optionalEnvBoolean.default(false),
  CJ_SYNC_TIME_START: z.coerce.date().default(new Date("2020-01-01T00:00:00.000Z")),
  CJ_SYNC_TIME_END: optionalEnvDate,
  CJ_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CJ_IP_QPS_LIMIT: z.coerce.number().int().positive().default(10),
  CJ_ADAPTIVE_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
  CJ_ADAPTIVE_RECOVERY_SUCCESSES: z.coerce.number().int().positive().default(120)
});

export const config = envSchema.parse(process.env);

export type AppConfig = typeof config;

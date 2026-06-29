import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

export function createPgClient(databaseUrl = config.DATABASE_URL) {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20
  });
}

export function createDb(databaseUrl = config.DATABASE_URL) {
  const client = createPgClient(databaseUrl);
  return {
    client,
    db: drizzle(client, { schema })
  };
}

export type Db = ReturnType<typeof createDb>["db"];

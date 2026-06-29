import { cjApiUsageLogs } from "../../db/schema.js";
import type { Db } from "../../db/client.js";
import type { CjApiError, CjCallResult } from "./cj-api-client.js";
import type { CjEndpoint } from "./constants.js";
import { formatPostgresErrorMessage, sanitizePostgresText } from "./postgres-sanitize.js";

export class CjUsageLogger {
  constructor(private readonly db: Db) {}

  async logSuccess<T>(accountId: string, result: CjCallResult<T>) {
    await this.db.insert(cjApiUsageLogs).values({
      accountId,
      endpoint: result.endpoint,
      method: result.method,
      statusCode: result.statusCode,
      cjCode: result.envelope.code,
      cjResult: result.envelope.result ?? result.envelope.success ?? true,
      message: optionalText(result.envelope.message),
      requestId: optionalText(result.envelope.requestId),
      pointsCost: result.pointsCost,
      pointsUsedToday: result.envelope.pointsInfo?.usedToday,
      pointsRemaining: result.envelope.pointsInfo?.remaining,
      pointsTotal: result.envelope.pointsInfo?.total,
      durationMs: result.durationMs
    });
  }

  async logError(input: {
    accountId: string;
    endpoint: CjEndpoint;
    method: "GET" | "POST";
    pointsCost: number;
    durationMs: number;
    error: unknown;
  }) {
    const error = input.error as CjApiError;
    await this.db.insert(cjApiUsageLogs).values({
      accountId: input.accountId,
      endpoint: input.endpoint,
      method: input.method,
      statusCode: error.statusCode,
      cjCode: error.cjCode,
      cjResult: false,
      message: formatPostgresErrorMessage(input.error),
      requestId: optionalText(error.requestId),
      pointsCost: input.pointsCost,
      pointsUsedToday: error.pointsInfo?.usedToday,
      pointsRemaining: error.pointsInfo?.remaining,
      pointsTotal: error.pointsInfo?.total,
      durationMs: input.durationMs,
      errorMessage: formatPostgresErrorMessage(input.error)
    });
  }
}

function optionalText(value: string | null | undefined) {
  return value == null ? undefined : sanitizePostgresText(value);
}

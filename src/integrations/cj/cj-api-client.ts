import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { cjAccounts } from "../../db/schema.js";
import { CJ_ENDPOINT_POINT_COST, CJ_ENDPOINTS, type CjEndpoint } from "./constants.js";
import type {
  CjAuthTokenData,
  CjCategoryLevel1,
  CjEnvelope,
  CjListV2Params,
  CjProductListV2Data,
  CjWarehouse
} from "./types.js";

export class CjApiError extends Error {
  readonly endpoint: CjEndpoint;
  readonly statusCode: number | undefined;
  readonly cjCode: number | undefined;
  readonly requestId: string | undefined;
  readonly pointsInfo: CjEnvelope<unknown>["pointsInfo"] | undefined;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    endpoint: CjEndpoint;
    statusCode?: number | undefined;
    cjCode?: number | undefined;
    requestId?: string | undefined;
    pointsInfo?: CjEnvelope<unknown>["pointsInfo"] | undefined;
    retryable?: boolean | undefined;
  }) {
    super(input.message);
    this.name = "CjApiError";
    this.endpoint = input.endpoint;
    this.statusCode = input.statusCode;
    this.cjCode = input.cjCode;
    this.requestId = input.requestId;
    this.pointsInfo = input.pointsInfo;
    this.retryable = input.retryable ?? false;
  }
}

export interface CjApiClientOptions {
  db: Db;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenRefreshSkewMs?: number;
}

export interface CjCallResult<T> {
  endpoint: CjEndpoint;
  method: "GET" | "POST";
  statusCode: number;
  durationMs: number;
  pointsCost: number;
  envelope: CjEnvelope<T>;
}

export class CjApiClient {
  private readonly db: Db;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenRefreshSkewMs: number;

  constructor(options: CjApiClientOptions) {
    this.db = options.db;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenRefreshSkewMs = options.tokenRefreshSkewMs ?? 24 * 60 * 60 * 1000;
  }

  async getCategory(accountId: string) {
    return this.get<CjCategoryLevel1[]>(accountId, CJ_ENDPOINTS.getCategory);
  }

  async getAccessTokenByApiKey(apiKey: string) {
    return this.post<CjAuthTokenData>(CJ_ENDPOINTS.getAccessToken, { apiKey });
  }

  async refreshAccessToken(refreshToken: string) {
    return this.post<CjAuthTokenData>(CJ_ENDPOINTS.refreshAccessToken, { refreshToken });
  }

  async getGlobalWarehouseList(accountId: string) {
    return this.get<CjWarehouse[]>(accountId, CJ_ENDPOINTS.globalWarehouseList);
  }

  async listProductsV2(accountId: string, params: CjListV2Params) {
    return this.get<CjProductListV2Data>(accountId, CJ_ENDPOINTS.productListV2, params as Record<string, unknown>);
  }

  async get<T>(accountId: string, endpoint: CjEndpoint, params?: Record<string, unknown>): Promise<CjCallResult<T>> {
    return this.request<T>(accountId, endpoint, "GET", params);
  }

  async post<T>(endpoint: CjEndpoint, body: Record<string, unknown>): Promise<CjCallResult<T>> {
    const url = this.buildUrl(endpoint);
    const started = performance.now();
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new CjApiError({
        endpoint,
        message: error instanceof Error ? error.message : "CJ request failed before response",
        retryable: true
      });
    }

    const durationMs = Math.round(performance.now() - started);
    const statusCode = response.status;
    const text = await response.text();
    const envelope = this.parseEnvelope<T>(text, endpoint, statusCode);

    if (!response.ok || envelope.code === 429) {
      throw new CjApiError({
        endpoint,
        message: envelope.message ?? `CJ HTTP ${statusCode}`,
        statusCode,
        cjCode: envelope.code,
        requestId: envelope.requestId,
        pointsInfo: envelope.pointsInfo,
        retryable: statusCode >= 500 || statusCode === 429
      });
    }

    if (!isSuccessfulCjEnvelope(envelope)) {
      throw new CjApiError({
        endpoint,
        message: envelope.message ?? `CJ business error ${envelope.code}`,
        statusCode,
        cjCode: envelope.code,
        requestId: envelope.requestId,
        pointsInfo: envelope.pointsInfo,
        retryable: false
      });
    }

    return {
      endpoint,
      method: "POST",
      statusCode,
      durationMs,
      pointsCost: CJ_ENDPOINT_POINT_COST[endpoint],
      envelope
    };
  }

  private async request<T>(
    accountId: string,
    endpoint: CjEndpoint,
    method: "GET" | "POST",
    params?: Record<string, unknown>
  ): Promise<CjCallResult<T>> {
    const token = await this.getAccessToken(accountId);
    const url = this.buildUrl(endpoint, params);
    const started = performance.now();
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          "CJ-Access-Token": token,
          "Accept": "application/json"
        }
      });
    } catch (error) {
      throw new CjApiError({
        endpoint,
        message: error instanceof Error ? error.message : "CJ request failed before response",
        retryable: true
      });
    }

    const durationMs = Math.round(performance.now() - started);
    const statusCode = response.status;
    const text = await response.text();
    const envelope = this.parseEnvelope<T>(text, endpoint, statusCode);

    if (!response.ok || envelope.code === 429) {
      throw new CjApiError({
        endpoint,
        message: envelope.message ?? `CJ HTTP ${statusCode}`,
        statusCode,
        cjCode: envelope.code,
        requestId: envelope.requestId,
        pointsInfo: envelope.pointsInfo,
        retryable: statusCode >= 500 || statusCode === 429
      });
    }

    if (!isSuccessfulCjEnvelope(envelope)) {
      throw new CjApiError({
        endpoint,
        message: envelope.message ?? `CJ business error ${envelope.code}`,
        statusCode,
        cjCode: envelope.code,
        requestId: envelope.requestId,
        pointsInfo: envelope.pointsInfo,
        retryable: false
      });
    }

    return {
      endpoint,
      method,
      statusCode,
      durationMs,
      pointsCost: CJ_ENDPOINT_POINT_COST[endpoint],
      envelope
    };
  }

  private parseEnvelope<T>(text: string, endpoint: CjEndpoint, statusCode: number): CjEnvelope<T> {
    try {
      return JSON.parse(text) as CjEnvelope<T>;
    } catch {
      throw new CjApiError({
        endpoint,
        statusCode,
        message: "CJ response was not valid JSON",
        retryable: statusCode >= 500
      });
    }
  }

  private buildUrl(endpoint: CjEndpoint, params?: Record<string, unknown>) {
    const url = new URL(`${this.baseUrl}${endpoint}`);

    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url;
  }

  private async getAccessToken(accountId: string) {
    const [account] = await this.db.select().from(cjAccounts).where(eq(cjAccounts.id, accountId)).limit(1);
    if (!account) {
      throw new Error(`CJ account not found: ${accountId}`);
    }

    const expiresAt = account.accessTokenExpiresAt?.getTime();
    if (!expiresAt || expiresAt - Date.now() > this.tokenRefreshSkewMs) {
      return account.accessToken;
    }

    if (!account.refreshToken) {
      throw new Error(`CJ account ${accountId} access token is near expiry and no refresh token is available`);
    }

    const refreshed = await this.refreshAccessToken(account.refreshToken);
    await this.db.update(cjAccounts).set({
      accessToken: refreshed.envelope.data.accessToken,
      refreshToken: refreshed.envelope.data.refreshToken,
      accessTokenExpiresAt: parseCjDate(refreshed.envelope.data.accessTokenExpiryDate),
      refreshTokenExpiresAt: parseCjDate(refreshed.envelope.data.refreshTokenExpiryDate),
      updatedAt: new Date()
    }).where(eq(cjAccounts.id, accountId));

    return refreshed.envelope.data.accessToken;
  }
}

function parseCjDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid CJ token date: ${value}`);
  }
  return date;
}

function isSuccessfulCjEnvelope(envelope: CjEnvelope<unknown>) {
  return (envelope.code === 0 || envelope.code === 200)
    && envelope.result !== false
    && envelope.success !== false;
}

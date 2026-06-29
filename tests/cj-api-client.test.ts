import { describe, expect, it, vi } from "vitest";
import { CjApiClient, CjApiError } from "../src/integrations/cj/cj-api-client.js";
import { CJ_ENDPOINTS } from "../src/integrations/cj/constants.js";

describe("CjApiClient", () => {
  it("gets access tokens from apiKey without requiring an existing account token", async () => {
    const body = {
      code: 200,
      result: true,
      success: true,
      message: "Success",
      data: {
        openId: 123456,
        accessToken: "access-token",
        accessTokenExpiryDate: "2026-07-15T09:16:33+08:00",
        refreshToken: "refresh-token",
        refreshTokenExpiryDate: "2026-12-15T09:16:33+08:00",
        createDate: "2026-06-29T09:16:33+08:00"
      },
      requestId: "auth-request"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const client = new CjApiClient({
      db: {} as never,
      baseUrl: "https://example.test/api2.0/v1",
      fetchImpl: fetchImpl as never
    });

    const result = await client.getAccessTokenByApiKey("api-key");

    expect(result.envelope.data.accessToken).toBe("access-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://example.test/api2.0/v1/authentication/getAccessToken"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ apiKey: "api-key" })
      })
    );
  });

  it("refreshes access tokens from refreshToken", async () => {
    const body = {
      code: 200,
      result: true,
      success: true,
      data: {
        accessToken: "new-access-token",
        accessTokenExpiryDate: "2026-07-15T09:16:33+08:00",
        refreshToken: "new-refresh-token",
        refreshTokenExpiryDate: "2026-12-15T09:16:33+08:00"
      },
      requestId: "refresh-request"
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const client = new CjApiClient({
      db: {} as never,
      baseUrl: "https://example.test/api2.0/v1",
      fetchImpl: fetchImpl as never
    });

    const result = await client.refreshAccessToken("refresh-token");

    expect(result.envelope.data.refreshToken).toBe("new-refresh-token");
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://example.test/api2.0/v1/authentication/refreshAccessToken"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refreshToken: "refresh-token" })
      })
    );
  });

  it("returns successful CJ envelopes and keeps pointsInfo", async () => {
    const client = makeClient({
      code: 200,
      result: true,
      message: "Success",
      data: [],
      requestId: "req-1",
      pointsInfo: { usedToday: 50, remaining: 49950, total: 50000 }
    });

    const result = await client.getCategory("account-1");

    expect(result.envelope.requestId).toBe("req-1");
    expect(result.envelope.pointsInfo?.remaining).toBe(49950);
    expect(result.pointsCost).toBe(0);
  });

  it("accepts CJ success envelopes with code 0", async () => {
    const client = makeClient({
      code: 0,
      success: true,
      data: [{
        id: "CN",
        countryCode: "CN",
        nameEn: "China Warehouse"
      }],
      requestId: "warehouse-req"
    });

    const result = await client.getGlobalWarehouseList("account-1");

    expect(result.envelope.requestId).toBe("warehouse-req");
    expect(result.envelope.data).toHaveLength(1);
    expect(result.envelope.data[0]?.countryCode).toBe("CN");
  });

  it("throws a non-retryable error for CJ business errors", async () => {
    const client = makeClient({
      code: 1600100,
      result: false,
      message: "Param error",
      data: null,
      requestId: "req-bad"
    });

    await expect(client.getGlobalWarehouseList("account-1")).rejects.toMatchObject({
      name: "CjApiError",
      cjCode: 1600100,
      requestId: "req-bad",
      retryable: false
    });
  });

  it("throws a retryable error for insufficient CJ points", async () => {
    const client = makeClient({
      code: 429,
      result: false,
      message: "Insufficient API points",
      data: null,
      pointsInfo: { usedToday: 50000, remaining: 0, total: 50000 }
    }, 429);

    await expect(client.listProductsV2("account-1", { page: 1 })).rejects.toMatchObject({
      name: "CjApiError",
      statusCode: 429,
      retryable: true
    });
  });
});

function makeClient(body: unknown, status = 200) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: "account-1",
            accessToken: "token",
            accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          }])
        })
      })
    })
  } as never;

  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status }));

  return new CjApiClient({
    db,
    baseUrl: "https://example.test/api2.0/v1",
    fetchImpl: fetchImpl as never
  });
}

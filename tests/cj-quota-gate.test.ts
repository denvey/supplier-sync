import { describe, expect, it } from "vitest";
import { CjQuotaGate, QuotaExceededError } from "../src/integrations/cj/cj-quota-gate.js";
import { CJ_ENDPOINTS } from "../src/integrations/cj/constants.js";

describe("CjQuotaGate", () => {
  it("uses July 1 2026 for accounts registered before June 1", () => {
    expect(CjQuotaGate.pointsEffectiveAt(new Date("2026-05-31T23:59:59.000Z")).toISOString())
      .toBe("2026-07-01T00:00:00.000Z");
  });

  it("uses June 1 2026 for accounts registered from June 1", () => {
    expect(CjQuotaGate.pointsEffectiveAt(new Date("2026-06-01T00:00:00.000Z")).toISOString())
      .toBe("2026-06-01T00:00:00.000Z");
  });

  it("enforces local point budget after points mode starts", async () => {
    const redis = new MemoryRedis();
    const gate = new CjQuotaGate({
      redis: redis as never,
      ipQpsLimit: 10,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
      sleep: async () => undefined
    });

    await gate.waitForTurn({
      id: "account-1",
      registeredAt: new Date("2026-06-01T00:00:00.000Z"),
      qpsLimit: 10,
      dailyPointBudget: 50,
      pointsEffectiveAt: new Date("2026-06-01T00:00:00.000Z")
    }, CJ_ENDPOINTS.productListV2);

    await expect(gate.waitForTurn({
      id: "account-1",
      registeredAt: new Date("2026-06-01T00:00:00.000Z"),
      qpsLimit: 10,
      dailyPointBudget: 50,
      pointsEffectiveAt: new Date("2026-06-01T00:00:00.000Z")
    }, CJ_ENDPOINTS.productListV2)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("lowers the adaptive QPS tier after rate-limit feedback", async () => {
    const redis = new MemoryRedis();
    const gate = new CjQuotaGate({
      redis: redis as never,
      ipQpsLimit: 10,
      adaptiveCooldownMs: 60_000,
      now: () => new Date("2026-06-29T00:00:00.000Z"),
      sleep: async () => undefined
    });

    const result = await gate.recordRateLimited({
      id: "account-2",
      registeredAt: new Date("2026-05-01T00:00:00.000Z"),
      qpsLimit: 6,
      dailyPointBudget: 50_000,
      pointsEffectiveAt: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      previousLimit: 6,
      nextLimit: 4,
      cooldownMs: 60_000
    });
    expect(await redis.get("cj:qps:adaptive:account-2:limit")).toBe("4");
  });

  it("recovers adaptive QPS after enough successful requests", async () => {
    const redis = new MemoryRedis();
    const gate = new CjQuotaGate({
      redis: redis as never,
      ipQpsLimit: 10,
      adaptiveRecoverySuccesses: 2,
      now: () => new Date("2026-06-29T00:00:00.000Z"),
      sleep: async () => undefined
    });
    const account = {
      id: "account-3",
      registeredAt: new Date("2026-05-01T00:00:00.000Z"),
      qpsLimit: 6,
      dailyPointBudget: 50_000,
      pointsEffectiveAt: new Date("2026-07-01T00:00:00.000Z")
    };

    await gate.recordRateLimited(account);
    expect(await redis.get("cj:qps:adaptive:account-3:limit")).toBe("4");

    expect(await gate.recordSuccess(account)).toMatchObject({ recovered: false, currentLimit: 4 });
    expect(await gate.recordSuccess(account)).toMatchObject({ recovered: true, currentLimit: 6 });
    expect(await redis.get("cj:qps:adaptive:account-3:limit")).toBeUndefined();
  });
});

class MemoryRedis {
  private readonly values = new Map<string, number>();
  private readonly strings = new Map<string, string>();

  async eval(script: string, _numKeys: number, key: string, ...args: unknown[]) {
    if (script.includes("INCRBY")) {
      const cost = Number(args[0]);
      const budget = Number(args[1]);
      const next = (this.values.get(key) ?? 0) + cost;
      this.values.set(key, next);
      return next > budget ? 0 : next;
    }

    const limit = Number(args[0]);
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next > limit ? 0 : 1;
  }

  async get(key: string) {
    return this.strings.get(key);
  }

  async set(key: string, value: string) {
    this.strings.set(key, value);
    return "OK";
  }

  async del(key: string) {
    const deleted = this.strings.delete(key);
    this.values.delete(key);
    return deleted ? 1 : 0;
  }

  async incr(key: string) {
    const next = Number(this.strings.get(key) ?? 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async pexpire() {
    return 1;
  }
}

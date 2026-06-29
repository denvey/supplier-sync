import type { Redis } from "ioredis";
import { CJ_ENDPOINT_POINT_COST, CJ_NEW_ACCOUNT_POINTS_EFFECTIVE_AT, CJ_OLD_ACCOUNT_POINTS_EFFECTIVE_AT, type CjEndpoint } from "./constants.js";

export interface QuotaAccount {
  id: string;
  registeredAt: Date;
  qpsLimit: number;
  dailyPointBudget: number;
  pointsEffectiveAt: Date;
}

export interface QuotaGateOptions {
  redis: Redis;
  ipKey?: string;
  ipQpsLimit: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  adaptiveCooldownMs?: number;
  adaptiveRecoverySuccesses?: number;
  adaptiveStateTtlMs?: number;
}

export class QuotaExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "QuotaExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

const TAKE_TOKEN_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  return 0
end
return 1
`;

const TAKE_POINTS_LUA = `
local current = redis.call("INCRBY", KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
  redis.call("EXPIRE", KEYS[1], ARGV[3])
end
if current > tonumber(ARGV[2]) then
  return 0
end
return current
`;

export class CjQuotaGate {
  private readonly redis: Redis;
  private readonly ipKey: string;
  private readonly ipQpsLimit: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly adaptiveCooldownMs: number;
  private readonly adaptiveRecoverySuccesses: number;
  private readonly adaptiveStateTtlMs: number;

  constructor(options: QuotaGateOptions) {
    this.redis = options.redis;
    this.ipKey = options.ipKey ?? "default";
    this.ipQpsLimit = options.ipQpsLimit;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.adaptiveCooldownMs = options.adaptiveCooldownMs ?? 60_000;
    this.adaptiveRecoverySuccesses = options.adaptiveRecoverySuccesses ?? 120;
    this.adaptiveStateTtlMs = options.adaptiveStateTtlMs ?? 6 * 60 * 60 * 1000;
  }

  async waitForTurn(account: QuotaAccount, endpoint: CjEndpoint) {
    await this.waitForAdaptiveCooldown(account.id);
    const accountQpsLimit = await this.getEffectiveAccountQpsLimit(account);
    await this.waitForQps(`cj:qps:account:${account.id}`, accountQpsLimit);
    await this.waitForQps(`cj:qps:ip:${this.ipKey}`, this.ipQpsLimit);

    const pointsCost = CJ_ENDPOINT_POINT_COST[endpoint] ?? 0;
    if (pointsCost > 0 && this.isPointsMode(account)) {
      await this.takePoints(account, pointsCost);
    }
  }

  async recordRateLimited(account: QuotaAccount) {
    const currentLimit = await this.getEffectiveAccountQpsLimit(account);
    const nextLimit = this.nextLowerQpsLimit(currentLimit);
    const now = this.now().getTime();

    await this.redis.set(this.adaptiveLimitKey(account.id), String(nextLimit), "PX", this.adaptiveStateTtlMs);
    await this.redis.set(
      this.adaptiveCooldownKey(account.id),
      String(now + this.adaptiveCooldownMs),
      "PX",
      this.adaptiveCooldownMs
    );
    await this.redis.del(this.adaptiveSuccessKey(account.id));

    return {
      previousLimit: currentLimit,
      nextLimit,
      cooldownMs: this.adaptiveCooldownMs
    };
  }

  async recordSuccess(account: QuotaAccount) {
    const currentLimit = await this.getEffectiveAccountQpsLimit(account);
    if (currentLimit >= account.qpsLimit) {
      return {
        currentLimit,
        recovered: false
      };
    }

    const successCount = await this.redis.incr(this.adaptiveSuccessKey(account.id));
    if (successCount === 1) {
      await this.redis.pexpire(this.adaptiveSuccessKey(account.id), this.adaptiveStateTtlMs);
    }

    if (successCount < this.adaptiveRecoverySuccesses) {
      return {
        currentLimit,
        recovered: false
      };
    }

    const nextLimit = this.nextHigherQpsLimit(currentLimit, account.qpsLimit);
    if (nextLimit >= account.qpsLimit) {
      await this.redis.del(this.adaptiveLimitKey(account.id));
    } else {
      await this.redis.set(this.adaptiveLimitKey(account.id), String(nextLimit), "PX", this.adaptiveStateTtlMs);
    }
    await this.redis.del(this.adaptiveSuccessKey(account.id));

    return {
      currentLimit: nextLimit,
      recovered: true
    };
  }

  isPointsMode(account: Pick<QuotaAccount, "registeredAt" | "pointsEffectiveAt">) {
    return this.now().getTime() >= account.pointsEffectiveAt.getTime();
  }

  async getEffectiveAccountQpsLimit(account: QuotaAccount) {
    return this.effectiveAccountQpsLimit(account);
  }

  static pointsEffectiveAt(registeredAt: Date) {
    return registeredAt.getTime() >= CJ_NEW_ACCOUNT_POINTS_EFFECTIVE_AT.getTime()
      ? CJ_NEW_ACCOUNT_POINTS_EFFECTIVE_AT
      : CJ_OLD_ACCOUNT_POINTS_EFFECTIVE_AT;
  }

  private async waitForQps(key: string, limit: number) {
    while (true) {
      const allowed = await this.redis.eval(TAKE_TOKEN_LUA, 1, key, limit, 1000);
      if (Number(allowed) === 1) return;
      await this.sleep(100);
    }
  }

  private async waitForAdaptiveCooldown(accountId: string) {
    while (true) {
      const cooldownUntilRaw = await this.redis.get(this.adaptiveCooldownKey(accountId));
      const cooldownUntil = Number(cooldownUntilRaw ?? 0);
      const waitMs = cooldownUntil - this.now().getTime();
      if (!Number.isFinite(waitMs) || waitMs <= 0) return;
      await this.sleep(Math.min(waitMs, 5_000));
    }
  }

  private async effectiveAccountQpsLimit(account: QuotaAccount) {
    const adaptiveLimitRaw = await this.redis.get(this.adaptiveLimitKey(account.id));
    const adaptiveLimit = Number(adaptiveLimitRaw ?? account.qpsLimit);
    if (!Number.isFinite(adaptiveLimit) || adaptiveLimit <= 0) return account.qpsLimit;
    return Math.max(1, Math.min(account.qpsLimit, Math.floor(adaptiveLimit)));
  }

  private nextLowerQpsLimit(currentLimit: number) {
    if (currentLimit > 4) return 4;
    if (currentLimit > 2) return 2;
    return 1;
  }

  private nextHigherQpsLimit(currentLimit: number, configuredLimit: number) {
    if (currentLimit < 2) return Math.min(2, configuredLimit);
    if (currentLimit < 4) return Math.min(4, configuredLimit);
    return configuredLimit;
  }

  private adaptiveLimitKey(accountId: string) {
    return `cj:qps:adaptive:${accountId}:limit`;
  }

  private adaptiveCooldownKey(accountId: string) {
    return `cj:qps:adaptive:${accountId}:cooldown_until`;
  }

  private adaptiveSuccessKey(accountId: string) {
    return `cj:qps:adaptive:${accountId}:success_count`;
  }

  private async takePoints(account: QuotaAccount, pointsCost: number) {
    const key = `cj:points:${account.id}:${this.utcDateKey(this.now())}`;
    const ttl = this.secondsUntilNextUtcDay(this.now());
    const result = Number(await this.redis.eval(
      TAKE_POINTS_LUA,
      1,
      key,
      pointsCost,
      account.dailyPointBudget,
      ttl
    ));

    if (result === 0) {
      throw new QuotaExceededError("CJ daily point budget exhausted locally", 60_000);
    }
  }

  private utcDateKey(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private secondsUntilNextUtcDay(date: Date) {
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
    return Math.max(60, Math.ceil((next.getTime() - date.getTime()) / 1000));
  }
}

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { cjAccounts, type CjAccount } from "../../db/schema.js";
import { CjQuotaGate } from "./cj-quota-gate.js";
import type { CjAuthTokenData } from "./types.js";

export interface EnsureAccountInput {
  accountId?: string | undefined;
  name: string;
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  registeredAt: Date;
  qpsLimit: number;
}

export interface StoreTokenInput {
  accountId?: string | undefined;
  name: string;
  tokenData: CjAuthTokenData;
  registeredAt: Date;
  qpsLimit: number;
}

export class CjAccountService {
  constructor(private readonly db: Db) {}

  async getActiveAccount(accountId?: string): Promise<CjAccount> {
    if (accountId) {
      const [account] = await this.db.select().from(cjAccounts).where(eq(cjAccounts.id, accountId)).limit(1);
      if (!account) throw new Error(`CJ account not found: ${accountId}`);
      return account;
    }

    const [account] = await this.db.select().from(cjAccounts).where(eq(cjAccounts.isActive, true)).limit(1);
    if (!account) {
      throw new Error("No active CJ account found. Set CJ_ACCESS_TOKEN or insert a row into cj_accounts.");
    }
    return account;
  }

  async ensureDefaultAccount(input: EnsureAccountInput): Promise<CjAccount> {
    if (input.accountId) {
      return this.getActiveAccount(input.accountId);
    }

    const [existing] = await this.db.select().from(cjAccounts).where(eq(cjAccounts.name, input.name)).limit(1);
    if (existing) {
      const [updated] = await this.db.update(cjAccounts).set({
        accessToken: input.accessToken ?? existing.accessToken,
        refreshToken: input.refreshToken ?? existing.refreshToken,
        registeredAt: input.registeredAt,
        qpsLimit: input.qpsLimit,
        pointsEffectiveAt: CjQuotaGate.pointsEffectiveAt(input.registeredAt),
        updatedAt: new Date()
      }).where(eq(cjAccounts.id, existing.id)).returning();
      if (!updated) throw new Error("Failed to update CJ account");
      return updated;
    }

    if (!input.accessToken) {
      throw new Error("CJ_ACCESS_TOKEN is required, or set CJ_API_KEY and run pnpm cj:auth:token first");
    }

    const [created] = await this.db.insert(cjAccounts).values({
      name: input.name,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      registeredAt: input.registeredAt,
      qpsLimit: input.qpsLimit,
      pointsEffectiveAt: CjQuotaGate.pointsEffectiveAt(input.registeredAt)
    }).returning();

    if (!created) throw new Error("Failed to create CJ account");
    return created;
  }

  async storeToken(input: StoreTokenInput): Promise<CjAccount> {
    const tokenValues = {
      accessToken: input.tokenData.accessToken,
      refreshToken: input.tokenData.refreshToken,
      accessTokenExpiresAt: parseCjDate(input.tokenData.accessTokenExpiryDate),
      refreshTokenExpiresAt: parseCjDate(input.tokenData.refreshTokenExpiryDate),
      registeredAt: input.registeredAt,
      qpsLimit: input.qpsLimit,
      pointsEffectiveAt: CjQuotaGate.pointsEffectiveAt(input.registeredAt),
      updatedAt: new Date()
    };

    if (input.accountId) {
      const [updated] = await this.db.update(cjAccounts).set(tokenValues)
        .where(eq(cjAccounts.id, input.accountId))
        .returning();
      if (!updated) throw new Error(`CJ account not found: ${input.accountId}`);
      return updated;
    }

    const [existing] = await this.db.select().from(cjAccounts).where(eq(cjAccounts.name, input.name)).limit(1);
    if (existing) {
      const [updated] = await this.db.update(cjAccounts).set(tokenValues)
        .where(eq(cjAccounts.id, existing.id))
        .returning();
      if (!updated) throw new Error("Failed to update CJ account tokens");
      return updated;
    }

    const [created] = await this.db.insert(cjAccounts).values({
      name: input.name,
      ...tokenValues
    }).returning();
    if (!created) throw new Error("Failed to create CJ account from token response");
    return created;
  }
}

function parseCjDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid CJ token date: ${value}`);
  }
  return date;
}

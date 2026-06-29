import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("config", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("treats blank optional environment values as undefined", async () => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CJ_ACCOUNT_ID: "",
      CJ_API_KEY: "",
      CJ_ACCESS_TOKEN: "",
      CJ_REFRESH_TOKEN: "",
      CJ_SYNC_TIME_END: ""
    };

    const { config } = await import("../src/config.js");

    expect(config.CJ_ACCOUNT_ID).toBeUndefined();
    expect(config.CJ_API_KEY).toBeUndefined();
    expect(config.CJ_ACCESS_TOKEN).toBeUndefined();
    expect(config.CJ_REFRESH_TOKEN).toBeUndefined();
    expect(config.CJ_SYNC_TIME_END).toBeUndefined();
  });

  it("coerces a configured optional sync end time", async () => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CJ_SYNC_TIME_END: "2026-06-01T12:30:00.000Z"
    };

    const { config } = await import("../src/config.js");

    expect(config.CJ_SYNC_TIME_END).toBeInstanceOf(Date);
    expect(config.CJ_SYNC_TIME_END?.toISOString()).toBe("2026-06-01T12:30:00.000Z");
  });
});

import { describe, expect, it } from "vitest";
import {
  formatPostgresErrorMessage,
  sanitizePostgresJson,
  sanitizePostgresText
} from "../src/integrations/cj/postgres-sanitize.js";

describe("postgres sanitize helpers", () => {
  it("removes null bytes from text", () => {
    expect(sanitizePostgresText("a\u0000b")).toBe("ab");
  });

  it("sanitizes nested JSON values", () => {
    expect(sanitizePostgresJson({
      "bad\u0000key": "bad\u0000value",
      count: Number.POSITIVE_INFINITY,
      nested: ["x\u0000y"]
    })).toEqual({
      badkey: "badvalue",
      count: null,
      nested: ["xy"]
    });
  });

  it("formats database-safe error messages", () => {
    expect(formatPostgresErrorMessage(new Error("a\u0000bc"), 2)).toBe("ab");
  });
});

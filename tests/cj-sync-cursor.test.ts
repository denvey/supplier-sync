import { describe, expect, it } from "vitest";
import { CjSyncCursorStore } from "../src/integrations/cj/cj-sync-cursor.js";

describe("CjSyncCursorStore", () => {
  it("splits time windows into two non-overlapping ranges", () => {
    const store = new CjSyncCursorStore({} as never);
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-03T00:00:00.000Z");

    const [left, right] = store.splitTimeRange(start, end);

    expect(left?.timeStart).toEqual(start);
    expect(left?.timeEnd.getTime()).toBeLessThan(right!.timeStart.getTime());
    expect(right?.timeEnd).toEqual(end);
  });

  it("rejects windows too small to split", () => {
    const store = new CjSyncCursorStore({} as never);

    expect(() => store.splitTimeRange(
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-01T00:00:00.500Z")
    )).toThrow("Cannot split");
  });
});

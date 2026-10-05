import { describe, expect, it } from "vitest";
import { OPERATION_ID } from "@/server/config";
import { formatDuration, newOperationId } from "./format";

describe("formatDuration", () => {
  it.each([
    [-5000, "0 s"],
    [0, "0 s"],
    [59_999, "59 s"],
    [60_000, "1 min"],
    [29 * 60_000 + 59_000, "29 min"],
    [60 * 60_000, "1 h"],
    [65 * 60_000, "1 h 5 min"],
  ])("%d ms -> %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("newOperationId", () => {
  it("makes ids the server accepts, different each time", () => {
    const ids = Array.from({ length: 50 }, newOperationId);
    expect(ids.every((id) => OPERATION_ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(50);
  });
});

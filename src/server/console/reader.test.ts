import { describe, expect, it } from "vitest";
import { RailwayError } from "@/server/railway/errors";
import { create, makeConsole, SECOND } from "../../../tests/support/console";

const reads = (ctx: ReturnType<typeof makeConsole>) => ctx.railway.calls.filter((call) => call === "listInstances").length;

describe("SandboxReader", () => {
  it("serves ten simultaneous visitors with one Railway read", async () => {
    const ctx = makeConsole();
    await Promise.all(Array.from({ length: 10 }, () => ctx.service.snapshot(false)));
    expect(reads(ctx)).toBe(1);
  });

  it("reuses a reading for 1.5 seconds", async () => {
    const ctx = makeConsole();
    await ctx.service.snapshot(false);
    ctx.clock.advance(1.4 * SECOND);
    await ctx.service.snapshot(false);
    expect(reads(ctx)).toBe(1);

    ctx.clock.advance(0.2 * SECOND);
    await ctx.service.snapshot(false);
    expect(reads(ctx)).toBe(2);
  });

  it("serves the latest reading, with its real time, once the read budget is spent", async () => {
    const ctx = makeConsole();
    let last = await ctx.service.snapshot(false);
    for (let poll = 0; poll < 40; poll++) {
      ctx.clock.advance(1.6 * SECOND);
      last = await ctx.service.snapshot(false);
    }

    // One free first read, a burst of 20, and what refilled in 64 seconds at one per 4.5.
    expect(reads(ctx)).toBeLessThanOrEqual(1 + 20 + 15);
    expect(Date.parse(last.asOf)).toBeLessThan(ctx.clock.now());
  });

  it("lets a write read Railway even when the read budget is spent", async () => {
    const ctx = makeConsole();
    for (let poll = 0; poll < 30; poll++) {
      ctx.clock.advance(1.6 * SECOND);
      await ctx.service.snapshot(false);
    }

    await ctx.service.create(create("aaaaaaaa"));
    expect((await ctx.service.snapshot(true)).containers).toHaveLength(1);
  });

  it("keeps showing the last good reading, and says so, when Railway stops answering", async () => {
    const ctx = makeConsole();
    await ctx.service.create(create("aaaaaaaa"));
    const good = await ctx.service.snapshot(false);

    ctx.clock.advance(5 * SECOND);
    ctx.railway.failNext("listInstances", new RailwayError("no_response", "Railway did not answer", { operation: "SandboxState" }));
    const stale = await ctx.service.snapshot(false);

    expect(stale.containers).toEqual(good.containers);
    expect(stale.asOf).toBe(good.asOf);
    expect(stale.problem).toMatchObject({ code: "railway_no_response" });
  });

  it("fails outright when there is no earlier reading to fall back on", async () => {
    const ctx = makeConsole();
    ctx.railway.failNext("listInstances", new RailwayError("unauthorized", "Not Authorized", { operation: "SandboxState" }));
    await expect(ctx.service.snapshot(false)).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

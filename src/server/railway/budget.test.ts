import { describe, expect, it } from "vitest";
import { parseRatePolicy, RequestBudget } from "./budget";

const HOUR_MS = 3_600_000;

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("parseRatePolicy", () => {
  it("reads the header Railway sent during the probe", () => {
    expect(parseRatePolicy('"default";q=1000;w=3600')).toEqual({ limit: 1000, windowMs: HOUR_MS });
  });

  it.each([null, "", "garbage", '"default";q=0;w=3600', '"default";q=abc;w=3600', '"default";q=100'])("rejects %j", (header) => {
    expect(parseRatePolicy(header)).toBeNull();
  });
});

describe("RequestBudget", () => {
  it("assumes the smallest plan until Railway states its policy", () => {
    const budget = new RequestBudget(clock().now);
    expect(budget.snapshot()).toMatchObject({ limit: 100, source: "assumed" });

    budget.observePolicy({ limit: 1000, windowMs: HOUR_MS });
    expect(budget.snapshot()).toMatchObject({ limit: 1000, windowSeconds: 3600, source: "railway" });
  });

  it("counts requests over a sliding window", () => {
    const time = clock();
    const budget = new RequestBudget(time.now);
    budget.observePolicy({ limit: 1000, windowMs: HOUR_MS });

    budget.record();
    time.advance(HOUR_MS / 2);
    budget.record();
    expect(budget.snapshot().used).toBe(2);

    time.advance(HOUR_MS / 2);
    expect(budget.snapshot().used).toBe(1);

    time.advance(HOUR_MS / 2);
    expect(budget.snapshot().used).toBe(0);
  });

  it("allows a burst of reads, then one read per refill interval", () => {
    const time = clock();
    const budget = new RequestBudget(time.now);
    budget.observePolicy({ limit: 1000, windowMs: HOUR_MS });
    expect(budget.readIntervalMs).toBe(4500);

    const burst = Array.from({ length: 25 }, () => budget.tryTakeRead()).filter(Boolean);
    expect(burst).toHaveLength(20);

    time.advance(4499);
    expect(budget.tryTakeRead()).toBe(false);
    time.advance(1);
    expect(budget.tryTakeRead()).toBe(true);
    expect(budget.tryTakeRead()).toBe(false);
  });

  it("never lets reads exceed burst + 80% of the limit in an hour, however often it is asked", () => {
    for (const limit of [100, 1000, 10_000]) {
      const time = clock();
      const budget = new RequestBudget(time.now);
      budget.observePolicy({ limit, windowMs: HOUR_MS });

      let reads = 0;
      for (let elapsed = 0; elapsed < HOUR_MS; elapsed += 250) {
        if (budget.tryTakeRead()) reads++;
        time.advance(250);
      }
      expect(reads).toBeLessThanOrEqual(20 + limit * 0.8);
      expect(reads).toBeGreaterThan(limit * 0.7);
    }
  });

  it("does not bank more than the burst while idle", () => {
    const time = clock();
    const budget = new RequestBudget(time.now);
    time.advance(10 * HOUR_MS);
    expect(Array.from({ length: 50 }, () => budget.tryTakeRead()).filter(Boolean)).toHaveLength(20);
  });
});

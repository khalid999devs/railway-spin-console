import { describe, expect, it } from "vitest";
import { createSerialQueue } from "./queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSerialQueue", () => {
  it("runs tasks one at a time, in order", async () => {
    const enqueue = createSerialQueue();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      log.push(`${name} end`);
      return name;
    };

    const results = await Promise.all([enqueue(task("a")), enqueue(task("b")), enqueue(task("c"))]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("keeps going after a task fails, and reports the failure to its own caller only", async () => {
    const enqueue = createSerialQueue();
    const failed = enqueue(async () => {
      throw new Error("boom");
    });
    const next = enqueue(async () => "fine");

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("fine");
  });
});
